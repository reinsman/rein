//! 独立 HTTP/A2A 路径；用 Task 快照轮询，不将断线当作远端已停止。
use super::a2a_client::Client;
use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use ra2a::types::{self as a2a, Part, SendMessageRequest, SendMessageResponse, TaskState};
use rein_proto::hub::v1::{self as pb, execution_event as ev};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

const INTERACTION: &str = "urn:a2alinker:interaction:v1";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct A2aRunOptions {
    pub url: String,
    pub token_env: Option<String>,
}
impl A2aRunOptions {
    pub fn validate(&self) -> Result<()> {
        let url = url::Url::parse(&self.url)?;
        ensure!(
            matches!(url.scheme(), "http" | "https")
                && url.host_str().is_some()
                && url.username().is_empty()
                && url.password().is_none()
                && url.fragment().is_none()
                && url.query().is_none(),
            "A2A URL must be http(s) without embedded credentials"
        );
        if let Some(name) = &self.token_env {
            ensure!(
                !name.starts_with("REIN_")
                    && !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
                "invalid A2A token environment name"
            )
        };
        Ok(())
    }
    pub(crate) fn client(&self) -> Result<Client> {
        self.validate()?;
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("a2a-extensions", INTERACTION.parse()?);
        if let Some(name) = &self.token_env {
            let token = std::env::var(name)
                .context("A2A token environment variable is not set in daemon")?;
            headers.insert(
                "authorization",
                format!("Bearer {token}")
                    .parse()
                    .map_err(|_| anyhow::anyhow!("invalid A2A token"))?,
            );
            headers
                .get_mut("authorization")
                .unwrap()
                .set_sensitive(true);
        };
        Client::new(&self.url, headers)
    }
}

type ControlMessage = (pb::ControlCommand, oneshot::Sender<Result<pb::CommandAck>>);
#[derive(Clone)]
pub struct A2aControl {
    cancel: CancellationToken,
    tx: mpsc::Sender<ControlMessage>,
    reference: Arc<Mutex<(Option<String>, Option<String>)>>,
    attempt: pb::AttemptRef,
}
impl A2aControl {
    pub fn cancel(&self) {
        self.cancel.cancel()
    }
    pub fn reference(&self) -> (Option<String>, Option<String>) {
        self.reference.lock().unwrap().clone()
    }
    pub async fn command(&self, c: &pb::ControlCommand) -> Result<pb::CommandAck> {
        ensure!(
            c.attempt.as_ref() == Some(&self.attempt),
            "attempt mismatch"
        );
        if matches!(c.payload, Some(pb::control_command::Payload::Cancel(_))) {
            self.cancel();
            return Ok(ack(c));
        };
        let (tx, rx) = oneshot::channel();
        self.tx
            .try_send((c.clone(), tx))
            .context("A2A execution control unavailable")?;
        match tokio::time::timeout(Duration::from_secs(20), rx).await {
            Ok(result) => result?,
            Err(_) => {
                let mut result = ack(c);
                result.error_code = "delivery_unknown".into();
                Ok(result)
            }
        }
    }
}
fn ack(c: &pb::ControlCommand) -> pb::CommandAck {
    pb::CommandAck {
        command_id: c.command_id.clone(),
        attempt: c.attempt.clone(),
        state: pb::CommandAckState::Received as i32,
        error_code: String::new(),
    }
}
pub struct A2aBackend {
    options: A2aRunOptions,
    control: A2aControl,
    rx: mpsc::Receiver<ControlMessage>,
    capabilities: Vec<String>,
}
impl A2aBackend {
    pub fn new(options: A2aRunOptions, attempt: pb::AttemptRef, context: Option<String>) -> Self {
        let (tx, rx) = mpsc::channel(8);
        Self {
            options,
            control: A2aControl {
                cancel: CancellationToken::new(),
                tx,
                reference: Arc::new(Mutex::new((context, None))),
                attempt,
            },
            rx,
            capabilities: ["a2a.poll", "a2a.cancel", "a2a.context.resume"]
                .map(String::from)
                .to_vec(),
        }
    }
    pub fn control_handle(&self) -> A2aControl {
        self.control.clone()
    }
    async fn run(
        &mut self,
        lease: &pb::RunLease,
        sender: &mut Sender,
    ) -> Result<(pb::RunState, bool)> {
        if self.control.cancel.is_cancelled() {
            return Ok((pb::RunState::Cancelled, true));
        }
        let discovery = self.options.client()?;
        let card = discovery.get_agent_card().await?;
        let interface = card
            .supported_interfaces
            .iter()
            .find(|interface| {
                interface.protocol_binding.is_jsonrpc()
                    && interface.protocol_version.starts_with("1.")
            })
            .context("A2A service has no supported v1 JSON-RPC interface")?;
        let endpoint = url::Url::parse(&interface.url)?;
        ensure!(
            endpoint.origin() == url::Url::parse(&self.options.url)?.origin()
                || self.options.token_env.is_none(),
            "A2A credentials cannot be forwarded to a different origin"
        );
        ensure!(
            url::Url::parse(&self.options.url)?.scheme() != "https" || endpoint.scheme() == "https",
            "A2A discovery cannot downgrade TLS"
        );
        let client = A2aRunOptions {
            url: endpoint.to_string(),
            token_env: self.options.token_env.clone(),
        }
        .client()?;
        let interaction_supported = card
            .capabilities
            .extensions
            .iter()
            .any(|e| e.uri == INTERACTION);
        let mut message = a2a::Message::user_text(&lease.prompt);
        message.id = self.control.attempt.attempt_id.clone().into();
        message.context_id = self.control.reference().0;
        let response = client
            .send_message(&SendMessageRequest::new(message).with_configuration(
                a2a::SendMessageConfiguration {
                    return_immediately: true,
                    history_length: None,
                    ..Default::default()
                },
            ))
            .await
            .context(
                "A2A submission failed; outcome may be unknown, refusing automatic resubmission",
            )?;
        let mut task = match response {
            SendMessageResponse::Message(message) => {
                *self.control.reference.lock().unwrap() = (message.context_id.clone(), None);
                sender
                    .emit(ev::Payload::Text(pb::TextEvent {
                        item_id: message.id.to_string(),
                        text: text(&message.parts),
                        complete: true,
                        reasoning: false,
                    }))
                    .await?;
                return Ok((pb::RunState::Completed, true));
            }
            SendMessageResponse::Task(task) => task,
        };
        let mut snapshots = HashMap::<String, Value>::new();
        let mut pending: Option<a2alinker::native::Interaction> = None;
        let mut previous = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1800);
        loop {
            *self.control.reference.lock().unwrap() =
                (Some(task.context_id.to_string()), Some(task.id.to_string()));
            for artifact in &task.artifacts {
                let key = format!("artifact:{}", artifact.artifact_id);
                let snapshot = serde_json::to_value(artifact)?;
                if snapshots.get(&key) != Some(&snapshot) {
                    snapshots.insert(key, snapshot);
                    sender
                        .emit(ev::Payload::Text(pb::TextEvent {
                            item_id: artifact.artifact_id.to_string(),
                            text: text(&artifact.parts),
                            complete: true,
                            reasoning: artifact
                                .metadata
                                .as_ref()
                                .and_then(|m| m.get("a2alinker"))
                                .is_some_and(|v| v["kind"] == "reasoning"),
                        }))
                        .await?;
                }
            }
            for message in task.history.iter().chain(task.status.message.iter()) {
                if message.role != a2a::Role::Agent {
                    continue;
                }
                let content = text(&message.parts);
                if task.artifacts.is_empty()
                    && !content.is_empty()
                    && !message.parts.iter().any(|part| part.as_data().is_some())
                {
                    let key = format!("message:{}", message.id);
                    let snapshot = json!(content);
                    if snapshots.get(&key) != Some(&snapshot) {
                        snapshots.insert(key, snapshot);
                        sender
                            .emit(ev::Payload::Text(pb::TextEvent {
                                item_id: message.id.to_string(),
                                text: content,
                                complete: true,
                                reasoning: false,
                            }))
                            .await?;
                    }
                }
                for part in &message.parts {
                    if let Some(data) = part.as_data()
                        && let Some(tool) = data.get("a2alinker").filter(|v| v["kind"] == "tool")
                    {
                        let key = format!("tool:{}", tool["toolCallId"].as_str().unwrap_or(""));
                        if snapshots.get(&key) != Some(tool) {
                            snapshots.insert(key, tool.clone());
                            sender
                                .emit(ev::Payload::Tool(pb::ToolEvent {
                                    call_id: tool["toolCallId"].as_str().unwrap_or("").into(),
                                    name: tool["name"].as_str().unwrap_or("tool").into(),
                                    input_json: serde_json::to_vec(&tool["arguments"])?,
                                    output_json: serde_json::to_vec(&tool["result"])?,
                                    complete: tool["type"] == "tool_result",
                                    is_error: tool["isError"] == true,
                                }))
                                .await?;
                        }
                    }
                }
            }
            let next = task_interaction(&task, interaction_supported)?;
            if let Some(interaction) = &next
                && pending.as_ref().map(|p| &p.id) != Some(&interaction.id)
            {
                sender
                    .emit(ev::Payload::Interaction(pb::InteractionEvent {
                        interaction_id: interaction.id.clone(),
                        approval_required: interaction.kind == "approval",
                        method: interaction.method.clone(),
                        parameters_json: serde_json::to_vec(&interaction.params)?,
                    }))
                    .await?;
            }
            pending = next;
            let state = match task.status.state {
                TaskState::Completed => pb::RunState::Completed,
                TaskState::Failed | TaskState::Rejected => pb::RunState::Failed,
                TaskState::Canceled => pb::RunState::Cancelled,
                TaskState::InputRequired | TaskState::AuthRequired => {
                    if pending.as_ref().is_some_and(|p| p.kind == "approval") {
                        pb::RunState::WaitingApproval
                    } else {
                        pb::RunState::WaitingInput
                    }
                }
                _ => pb::RunState::Running,
            };
            if task.status.state.is_terminal() {
                if state == pb::RunState::Failed {
                    sender
                        .emit(ev::Payload::Error(pb::ErrorEvent {
                            code: "a2a_task_failed".into(),
                            message: task
                                .status
                                .message
                                .as_ref()
                                .map(|m| text(&m.parts))
                                .unwrap_or_else(|| "remote Task failed".into()),
                        }))
                        .await?
                };
                return Ok((state, true));
            }
            if previous != Some(state) {
                sender
                    .emit(ev::Payload::State(pb::StateEvent {
                        state: state as i32,
                    }))
                    .await?;
                previous = Some(state)
            }
            tokio::select! {
             biased;
             _=self.control.cancel.cancelled()=>{
               let cancelled=client.cancel_task(&a2a::CancelTaskRequest{tenant:None,id:task.id.clone(),metadata:None}).await.context("remote cancellation outcome unknown")?;
               task=cancelled;
               if !task.status.state.is_terminal(){
                let end=tokio::time::Instant::now()+Duration::from_secs(10);
                while !task.status.state.is_terminal(){ensure!(tokio::time::Instant::now()<end,"remote cancellation not confirmed");tokio::time::sleep(Duration::from_millis(200)).await;task=client.get_task(&a2a::GetTaskRequest{tenant:None,id:task.id.clone(),history_length:None}).await?;}
               }
             }
             Some((command,response))=self.rx.recv()=>{
              let result=async{
               let reply=command.payload.as_ref().and_then(|p|match p{pb::control_command::Payload::InteractionReply(r)=>Some(r),_=>None}).context("unsupported A2A control")?;
               let interaction=pending.as_ref().context("no active A2A interaction")?;ensure!(reply.interaction_id==interaction.id,"A2A interaction mismatch");let value:Value=serde_json::from_slice(&reply.response_json)?;
               let parts=if interaction.method=="a2a.message" {
                   let text=value["text"].as_str().filter(|s|!s.trim().is_empty()).context("A2A input requires nonempty text")?;
                   vec![Part::text(text)]
               } else {
                   a2alinker::native::validate_reply(interaction,&value)?;
                   vec![Part::data(json!({"interactionId":interaction.id,"response":value}))]
               };
               let mut message=a2a::Message::user(parts).with_task_id(task.id.clone()).with_context_id(task.context_id.as_str());message.id=command.command_id.clone().into();
               let result=match client.send_message(&SendMessageRequest::new(message).with_configuration(a2a::SendMessageConfiguration{return_immediately:true,..Default::default()})).await {
                   Ok(result) => result,
                   Err(_) => { let mut result=ack(&command);result.error_code="delivery_unknown".into();return Ok(result); }
               };
               let SendMessageResponse::Task(next)=result else{bail!("interaction reply returned no Task")};ensure!(next.id==task.id&&next.context_id==task.context_id,"interaction reply changed Task/context");task=next;Ok(ack(&command))
              }.await;let _=response.send(result);
             }
             _=tokio::time::sleep_until(deadline)=>bail!("A2A task timed out; remote outcome unknown"),
             _=tokio::time::sleep(Duration::from_millis(200))=>{let next=client.get_task(&a2a::GetTaskRequest{tenant:None,id:task.id.clone(),history_length:None}).await?;ensure!(next.id==task.id&&next.context_id==task.context_id,"A2A Task/context changed");task=next;}
            }
        }
    }
}
fn task_interaction(
    task: &a2a::Task,
    extension: bool,
) -> Result<Option<a2alinker::native::Interaction>> {
    if let Some(value) = task
        .metadata
        .as_ref()
        .and_then(|m| m.get("pendingInteraction"))
    {
        ensure!(
            extension,
            "service requires an unsupported interaction extension"
        );
        return Ok(Some(serde_json::from_value(value.clone())?));
    }
    if task.status.state == TaskState::AuthRequired {
        bail!("A2A service requires authentication; configure daemon-side service credentials")
    }
    if task.status.state != TaskState::InputRequired {
        return Ok(None);
    }
    let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(&task.status)?));
    Ok(Some(a2alinker::native::Interaction {
        id: format!("a2a-{}-{}", task.id, &digest[..16]),
        kind: "input".into(),
        method: "a2a.message".into(),
        params: json!({"message":task.status.message.as_ref().map(|m|text(&m.parts)).unwrap_or_default()}),
    }))
}

fn text(parts: &[Part]) -> String {
    parts
        .iter()
        .filter_map(Part::as_text)
        .collect::<Vec<_>>()
        .join("\n")
}
struct Sender {
    attempt: pb::AttemptRef,
    sequence: u64,
    tx: mpsc::Sender<pb::ExecutionEvent>,
}
impl Sender {
    async fn emit(&mut self, payload: ev::Payload) -> Result<()> {
        self.sequence += 1;
        self.tx
            .send(pb::ExecutionEvent {
                attempt: Some(self.attempt.clone()),
                sequence: self.sequence,
                payload: Some(payload),
            })
            .await
            .context("event receiver closed")
    }
}
#[async_trait]
impl super::Backend for A2aBackend {
    fn kind(&self) -> pb::BackendKind {
        pb::BackendKind::A2a
    }
    fn capabilities(&self) -> &[String] {
        &self.capabilities
    }
    async fn control(&mut self, c: &pb::ControlCommand) -> Result<pb::CommandAck> {
        self.control.command(c).await
    }
    async fn execute(
        &mut self,
        lease: &pb::RunLease,
        tx: mpsc::Sender<pb::ExecutionEvent>,
    ) -> Result<()> {
        let mut sender = Sender {
            attempt: self.control.attempt.clone(),
            sequence: 0,
            tx,
        };
        let result = self.run(lease, &mut sender).await;
        let (state, stopped) = match result {
            Ok(result) => result,
            Err(error) => {
                sender
                    .emit(ev::Payload::Error(pb::ErrorEvent {
                        code: "a2a_execution".into(),
                        message: format!("{error:#}"),
                    }))
                    .await?;
                (pb::RunState::Failed, false)
            }
        };
        let (context, task) = self.control.reference();
        sender
            .emit(ev::Payload::Result(pb::ResultEvent {
                state: state as i32,
                execution_stopped: stopped,
                output: String::new(),
                execution: Some(pb::ExecutionRef {
                    backend: Some(pb::execution_ref::Backend::A2a(pb::A2aExecutionRef {
                        service_ref: lease
                            .run
                            .as_ref()
                            .map(|r| r.runtime_id.clone())
                            .unwrap_or_default(),
                        context_id: context.unwrap_or_default(),
                        task_id: task.unwrap_or_default(),
                    })),
                }),
            }))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn standard_a2a_input_is_correlated_without_native_extensions() {
        let mut task = a2a::Task::new("task", "context");
        task.status = a2a::TaskStatus::with_message(
            TaskState::InputRequired,
            a2a::Message::agent_text("Which branch?"),
        );
        let first = task_interaction(&task, false).unwrap().unwrap();
        assert_eq!(first.method, "a2a.message");
        assert_eq!(
            first.id,
            task_interaction(&task, false).unwrap().unwrap().id
        );
        assert_eq!(first.params["message"], "Which branch?");
        task.status = a2a::TaskStatus::with_message(
            TaskState::InputRequired,
            a2a::Message::agent_text("Which file?"),
        );
        assert_ne!(
            first.id,
            task_interaction(&task, false).unwrap().unwrap().id
        );
        task.status = a2a::TaskStatus::working();
        assert!(task_interaction(&task, false).unwrap().is_none());
    }
    #[test]
    fn a2a_credentials_remain_explicit_and_hub_variables_are_rejected() {
        for url in [
            "file:///tmp/agent",
            "https://user:secret@example.com",
            "https://example.com?token=secret",
        ] {
            assert!(
                A2aRunOptions {
                    url: url.into(),
                    token_env: None
                }
                .validate()
                .is_err()
            );
        }
        assert!(
            A2aRunOptions {
                url: "https://example.com".into(),
                token_env: Some("REIN_HUB_TOKEN".into())
            }
            .validate()
            .is_err()
        );
    }
}
