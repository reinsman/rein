//! 无 HTTP 的原生执行；会话拥有管道，控制句柄可在执行期间独立使用。

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use a2alinker::{
    AgentKind, Options,
    native::{
        AdapterContext, AgentEvent, AgentSession, Interaction, InteractionReply, RunOutcome,
        ToolPhase, create_session, validate_reply,
    },
};
use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use rein_proto::hub::v1::{self as pb, control_command, execution_event};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeRunOptions {
    pub provider: AgentKind,
    pub workspace: PathBuf,
    pub executable: Option<PathBuf>,
    pub native_config: Option<PathBuf>,
    pub model: Option<String>,
    #[serde(default)]
    pub prepare: Option<String>,
}

impl NativeRunOptions {
    pub fn resolve(self) -> Result<Options> {
        let mut options = Options::default();
        options.agent.kind = self.provider;
        options.agent.workspace = self.workspace;
        options.agent.executable = self.executable;
        options.agent.native_config = self.native_config;
        options.agent.model = self.model;
        options.agent.prepare = self.prepare;
        options.resolve()?;
        options.agent.workspace = options.agent.workspace.canonicalize()?;
        Ok(options)
    }
}

#[derive(Default)]
struct ControlState {
    attempt: Option<pb::AttemptRef>,
    cancel: CancellationToken,
    replies: Option<mpsc::Sender<InteractionReply>>,
    pending: HashMap<String, Interaction>,
    acknowledgments: HashMap<String, (pb::ControlCommand, pb::CommandAck)>,
    native_id: Option<String>,
    finished: bool,
}

#[derive(Clone, Default)]
pub struct NativeControl(Arc<Mutex<ControlState>>);

impl NativeControl {
    pub fn cancel(&self) {
        self.0.lock().unwrap().cancel.cancel();
    }

    pub fn native_id(&self) -> Option<String> {
        self.0.lock().unwrap().native_id.clone()
    }

    pub fn command(&self, command: &pb::ControlCommand) -> Result<pb::CommandAck> {
        let mut state = self.0.lock().unwrap();
        ensure!(!command.command_id.is_empty(), "command_id is required");
        ensure!(
            command.attempt.is_some() && command.attempt == state.attempt,
            "stale or mismatched attempt"
        );
        if let Some((original, ack)) = state.acknowledgments.get(&command.command_id) {
            ensure!(
                original == command,
                "command_id reused with a different payload"
            );
            return Ok(ack.clone());
        }
        ensure!(!state.finished, "execution already finished");
        ensure!(
            state.acknowledgments.len() < 1024,
            "too many control commands"
        );
        match command
            .payload
            .as_ref()
            .context("missing control payload")?
        {
            control_command::Payload::Cancel(_) => state.cancel.cancel(),
            control_command::Payload::InteractionReply(reply) => {
                ensure!(!state.cancel.is_cancelled(), "execution is cancelling");
                let interaction = state
                    .pending
                    .get(&reply.interaction_id)
                    .context("unknown or already answered interaction")?;
                let response = serde_json::from_slice(&reply.response_json)
                    .context("invalid interaction response JSON")?;
                validate_reply(interaction, &response)?;
                state
                    .replies
                    .as_ref()
                    .context("execution is not accepting replies")?
                    .try_send(InteractionReply {
                        id: reply.interaction_id.clone(),
                        response,
                    })
                    .context("cannot deliver interaction reply")?;
                state.pending.remove(&reply.interaction_id);
            }
            _ => bail!("native operation is not supported; no instruction was sent"),
        }
        // 这里只确认控制已入队；取消是否完成以 ResultEvent 为准。
        let ack = pb::CommandAck {
            command_id: command.command_id.clone(),
            attempt: command.attempt.clone(),
            state: pb::CommandAckState::Received as i32,
            error_code: String::new(),
        };
        state
            .acknowledgments
            .insert(command.command_id.clone(), (command.clone(), ack.clone()));
        Ok(ack)
    }
}

pub struct NativeBackend {
    pub options: Options,
    session: Option<Box<dyn AgentSession>>,
    control: NativeControl,
    capabilities: Vec<String>,
}

impl NativeBackend {
    pub fn new(options: Options) -> Self {
        Self {
            options,
            session: None,
            control: NativeControl::default(),
            capabilities: ["text", "tools", "interaction", "cancel", "session.resume"]
                .map(String::from)
                .to_vec(),
        }
    }

    pub fn control_handle(&self) -> NativeControl {
        self.control.clone()
    }

    pub fn restore_native_id(&mut self, native_id: Option<String>) {
        self.control.0.lock().unwrap().native_id = native_id;
    }

    pub fn prepare(&mut self, attempt: pb::AttemptRef) {
        let native_id = self.control.native_id();
        self.control = NativeControl(Arc::new(Mutex::new(ControlState {
            attempt: Some(attempt),
            native_id,
            ..ControlState::default()
        })));
    }

    async fn run_native(&mut self, prompt: &str, sender: &mut EventSender) -> Result<RunOutcome> {
        let (cancel, native_id) = {
            let state = self.control.0.lock().unwrap();
            (state.cancel.clone(), state.native_id.clone())
        };
        if cancel.is_cancelled() {
            return Ok(RunOutcome::Canceled);
        }
        let context = AdapterContext {
            options: Arc::new(self.options.clone()),
        };
        let start = tokio::time::timeout(
            Duration::from_secs(self.options.runtime.startup_timeout_seconds),
            create_session(&context, native_id.as_deref()),
        );
        tokio::pin!(start);
        self.session = Some(tokio::select! {
            result = &mut start => result.context("native startup timed out")??,
            _ = cancel.cancelled() => {
                // 握手结束后取得会话所有权，再明确清理；不会在取消后发起 prompt。
                tokio::time::timeout(Duration::from_secs(self.options.runtime.cancel_timeout_seconds), &mut start)
                    .await.context("startup interrupted before handshake; cleanup requested, outcome unknown")?
                    .context("native startup timed out")??
            },
        });
        let session = self.session.as_mut().unwrap();
        let (tx, mut rx) = mpsc::channel(32);
        let (replies, replies_rx) = mpsc::channel(8);
        {
            let mut state = self.control.0.lock().unwrap();
            state.native_id = Some(session.native_id().to_owned());
            state.replies = Some(replies);
        }
        if cancel.is_cancelled() {
            return Ok(RunOutcome::Canceled);
        }
        sender
            .send(execution_event::Payload::State(pb::StateEvent {
                state: pb::RunState::Running as i32,
            }))
            .await?;
        let future = session.run(prompt, tx, replies_rx, cancel.clone());
        tokio::pin!(future);
        let timeout = tokio::time::sleep(Duration::from_secs(
            self.options.runtime.task_timeout_seconds,
        ));
        tokio::pin!(timeout);
        let cancel_deadline = tokio::time::sleep(Duration::from_secs(86400 * 365));
        tokio::pin!(cancel_deadline);
        let mut cancelling = false;
        let mut timed_out = false;
        let mut stream_open = true;
        loop {
            tokio::select! {
                biased;
                _ = &mut cancel_deadline, if cancelling => {
                    if timed_out { bail!("native execution timed out"); }
                    return Ok(RunOutcome::Canceled);
                }
                _ = cancel.cancelled(), if !cancelling => {
                    cancelling = true;
                    cancel_deadline.as_mut().reset(tokio::time::Instant::now() + Duration::from_secs(self.options.runtime.cancel_timeout_seconds));
                }
                _ = &mut timeout, if !timed_out => {
                    timed_out = true;
                    cancel.cancel();
                }
                event = rx.recv(), if stream_open => match event {
                    Some(event) => forward(event, &self.control, sender).await?,
                    None => stream_open = false,
                },
                result = &mut future => {
                    while let Ok(event) = rx.try_recv() { forward(event, &self.control, sender).await?; }
                    if timed_out { bail!("native execution timed out"); }
                    return result;
                }
            }
        }
    }
}

struct EventSender {
    attempt: pb::AttemptRef,
    sequence: u64,
    tx: mpsc::Sender<pb::ExecutionEvent>,
    state: i32,
}

impl EventSender {
    async fn send(&mut self, payload: execution_event::Payload) -> Result<()> {
        if let execution_event::Payload::State(event) = &payload {
            self.state = event.state;
        }
        self.sequence += 1;
        self.tx
            .send(pb::ExecutionEvent {
                attempt: Some(self.attempt.clone()),
                sequence: self.sequence,
                payload: Some(payload),
            })
            .await
            .context("execution event receiver closed")
    }
}

async fn forward(
    event: AgentEvent,
    control: &NativeControl,
    sender: &mut EventSender,
) -> Result<()> {
    let resumed = matches!(sender.state, value if value == pb::RunState::WaitingInput as i32 || value == pb::RunState::WaitingApproval as i32)
        && control.0.lock().unwrap().pending.is_empty();
    if resumed {
        sender
            .send(execution_event::Payload::State(pb::StateEvent {
                state: pb::RunState::Running as i32,
            }))
            .await?;
    }
    let payload = match event {
        AgentEvent::OutputDelta { item_id, text } => {
            execution_event::Payload::Text(pb::TextEvent {
                item_id,
                text,
                complete: false,
                reasoning: false,
            })
        }
        AgentEvent::OutputComplete { item_id, text } => {
            execution_event::Payload::Text(pb::TextEvent {
                item_id,
                text,
                complete: true,
                reasoning: false,
            })
        }
        AgentEvent::Reasoning {
            item_id,
            text,
            append,
            ..
        } => execution_event::Payload::Text(pb::TextEvent {
            item_id,
            text,
            complete: !append,
            reasoning: true,
        }),
        AgentEvent::Tool(tool) => execution_event::Payload::Tool(pb::ToolEvent {
            call_id: tool.call_id,
            name: tool.name,
            input_json: tool
                .arguments
                .map(a2alinker::native::redact_fields)
                .map(|v| serde_json::to_vec(&v))
                .transpose()?
                .unwrap_or_default(),
            output_json: tool
                .result
                .map(a2alinker::native::redact_fields)
                .map(|v| serde_json::to_vec(&v))
                .transpose()?
                .unwrap_or_default(),
            complete: matches!(tool.phase, ToolPhase::End),
            is_error: tool.is_error.unwrap_or(false),
        }),
        AgentEvent::Interaction(interaction) => {
            let approval_required = interaction.kind == "approval";
            control
                .0
                .lock()
                .unwrap()
                .pending
                .insert(interaction.id.clone(), interaction.clone());
            sender
                .send(execution_event::Payload::Interaction(
                    pb::InteractionEvent {
                        interaction_id: interaction.id,
                        approval_required,
                        method: interaction.method,
                        parameters_json: serde_json::to_vec(&interaction.params)?,
                    },
                ))
                .await?;
            execution_event::Payload::State(pb::StateEvent {
                state: if approval_required {
                    pb::RunState::WaitingApproval
                } else {
                    pb::RunState::WaitingInput
                } as i32,
            })
        }
        AgentEvent::Progress(_) => return Ok(()),
    };
    sender.send(payload).await
}

#[async_trait]
impl super::Backend for NativeBackend {
    fn kind(&self) -> pb::BackendKind {
        pb::BackendKind::Native
    }
    fn capabilities(&self) -> &[String] {
        &self.capabilities
    }

    async fn execute(
        &mut self,
        lease: &pb::RunLease,
        events: mpsc::Sender<pb::ExecutionEvent>,
    ) -> Result<()> {
        let run = lease.run.as_ref().context("missing run")?;
        ensure!(
            !run.id.is_empty() && !run.attempt_id.is_empty(),
            "run and attempt IDs are required"
        );
        let attempt = pb::AttemptRef {
            run_id: run.id.clone(),
            attempt_id: run.attempt_id.clone(),
        };
        if self.control.0.lock().unwrap().attempt.as_ref() != Some(&attempt) {
            self.prepare(attempt.clone());
        }
        let mut sender = EventSender {
            attempt,
            sequence: 0,
            tx: events,
            state: pb::RunState::Unspecified as i32,
        };
        let result = self.run_native(&lease.prompt, &mut sender).await;
        let had_session = self.session.is_some();
        let never_started = matches!(result, Ok(RunOutcome::Canceled)) && !had_session;
        let stopped = match self.session.take() {
            Some(mut session) => session.shutdown().await,
            None => Ok(()),
        };
        let cleanup_confirmed = stopped.is_ok() && (had_session || never_started);
        {
            let mut state = self.control.0.lock().unwrap();
            state.finished = true;
            state.pending.clear();
            state.replies = None;
        }
        let (status, error) = match (result, stopped) {
            (_, Err(e)) => (
                pb::RunState::Failed,
                Some(format!("process cleanup failed: {e:#}")),
            ),
            (Ok(RunOutcome::Completed), _) => (pb::RunState::Completed, None),
            (Ok(RunOutcome::Canceled), _) => (pb::RunState::Cancelled, None),
            (Err(e), _) => (pb::RunState::Failed, Some(format!("{e:#}"))),
        };
        if let Some(message) = error {
            sender
                .send(execution_event::Payload::Error(pb::ErrorEvent {
                    code: "native_execution".into(),
                    message,
                }))
                .await?;
        }
        sender
            .send(execution_event::Payload::Result(pb::ResultEvent {
                state: status as i32,
                execution: Some(pb::ExecutionRef {
                    backend: Some(pb::execution_ref::Backend::Native(pb::NativeExecutionRef {
                        provider: self.options.agent.kind.as_str().into(),
                        session_ref: run.session_id.clone(),
                        turn_id: String::new(),
                    })),
                }),
                execution_stopped: cleanup_confirmed,
                output: String::new(),
            }))
            .await
    }

    async fn control(&mut self, command: &pb::ControlCommand) -> Result<pb::CommandAck> {
        self.control.command(command)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn control_fences_attempts_validates_replies_and_deduplicates_commands() {
        let mut backend = NativeBackend::new(Options::default());
        let attempt = pb::AttemptRef {
            run_id: "run-1".into(),
            attempt_id: "attempt-1".into(),
        };
        backend.prepare(attempt.clone());
        let control = backend.control_handle();
        let (tx, mut rx) = mpsc::channel(1);
        {
            let mut state = control.0.lock().unwrap();
            state.replies = Some(tx);
            state.pending.insert(
                "approval-1".into(),
                Interaction {
                    id: "approval-1".into(),
                    kind: "approval".into(),
                    method: "item/commandExecution/requestApproval".into(),
                    params: json!({}),
                },
            );
        }
        let mut command = pb::ControlCommand {
            command_id: "command-1".into(),
            attempt: Some(attempt.clone()),
            payload: Some(control_command::Payload::InteractionReply(
                pb::InteractionReplyCommand {
                    interaction_id: "approval-1".into(),
                    response_json: serde_json::to_vec(&json!({"decision":"accept"})).unwrap(),
                },
            )),
        };
        let ack = control.command(&command).unwrap();
        assert_eq!(ack.state, pb::CommandAckState::Received as i32);
        assert_eq!(control.command(&command).unwrap(), ack);
        assert_eq!(rx.try_recv().unwrap().id, "approval-1");
        assert!(rx.try_recv().is_err());
        command.payload = Some(control_command::Payload::Cancel(
            pb::CancelCommand::default(),
        ));
        assert!(control.command(&command).is_err());
        command.command_id = "command-2".into();
        command.attempt.as_mut().unwrap().attempt_id = "stale".into();
        assert!(control.command(&command).is_err());
        backend.prepare(pb::AttemptRef {
            run_id: "run-2".into(),
            attempt_id: "attempt-2".into(),
        });
        control.cancel();
        assert!(!backend.control.0.lock().unwrap().cancel.is_cancelled());
    }

    #[tokio::test]
    async fn unacknowledged_native_commands_are_bounded_by_task_timeout() {
        let temp = tempfile::tempdir().unwrap();
        let mut options = Options::default();
        options.agent.kind = AgentKind::Codex;
        options.agent.workspace = temp.path().into();
        options.agent.native_config = Some(temp.path().into());
        options.agent.executable = Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../a2alinker/crates/a2alinker/tests/fixtures/fake_agent.py"),
        );
        options.runtime.task_timeout_seconds = 1;
        options.runtime.cancel_timeout_seconds = 1;
        let mut backend = NativeBackend::new(options);
        let (tx, mut rx) = mpsc::channel(32);
        let lease = pb::RunLease {
            run: Some(pb::Run {
                id: "run-1".into(),
                attempt_id: "attempt-1".into(),
                ..Default::default()
            }),
            prompt: "hang-ack".into(),
            ..Default::default()
        };
        tokio::time::timeout(
            Duration::from_secs(6),
            super::super::Backend::execute(&mut backend, &lease, tx),
        )
        .await
        .unwrap()
        .unwrap();
        let mut events = vec![];
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        assert!(events.iter().any(|e| matches!(&e.payload, Some(execution_event::Payload::Error(e)) if e.message.contains("timed out"))));
        assert!(
            matches!(events.last().unwrap().payload, Some(execution_event::Payload::Result(ref r)) if r.state == pb::RunState::Failed as i32)
        );
        assert!(backend.session.is_none());
    }
}
