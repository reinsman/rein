//! 共用执行事件；本地原生执行与未来 Hub 租约使用同一 Backend。
pub mod a2a;
mod a2a_client;
pub mod native;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result, bail, ensure};
use async_trait::async_trait;
use rein_proto::hub::v1::{self as pb, execution_event};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{sync::mpsc, task::JoinHandle};
use uuid::Uuid;

use native::{NativeBackend, NativeControl, NativeRunOptions};

#[async_trait]
pub trait Backend: Send {
    fn kind(&self) -> pb::BackendKind;
    fn capabilities(&self) -> &[String];
    async fn execute(
        &mut self,
        lease: &pb::RunLease,
        events: mpsc::Sender<pb::ExecutionEvent>,
    ) -> Result<()>;
    async fn control(&mut self, command: &pb::ControlCommand) -> Result<pb::CommandAck>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalRun {
    pub run_id: String,
    pub attempt_id: String,
    pub session_id: String,
    pub provider: String,
    pub state: String,
    pub cancel_requested: bool,
    pub native_session_id: Option<String>,
    pub last_sequence: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalEvent {
    pub run_id: String,
    pub attempt_id: String,
    pub sequence: u64,
    pub event: Value,
}

struct RunEntry {
    snapshot: LocalRun,
    events: Vec<LocalEvent>,
    control: NativeControl,
    task: Option<JoinHandle<()>>,
    overflow: bool,
}

struct SessionEntry {
    options: a2alinker::Options,
    backend: Option<NativeBackend>,
    busy: bool,
}

#[derive(Default)]
struct ManagerState {
    runs: HashMap<String, RunEntry>,
    sessions: HashMap<String, SessionEntry>,
    history_bytes: usize,
    stopping: bool,
    hub_workspaces: HashMap<String, Option<std::path::PathBuf>>,
}

#[derive(Clone, Default)]
pub struct ExecutionManager(Arc<Mutex<ManagerState>>);

pub struct ExecutionPermit {
    manager: ExecutionManager,
    id: String,
}
impl Drop for ExecutionPermit {
    fn drop(&mut self) {
        self.manager
            .0
            .lock()
            .unwrap()
            .hub_workspaces
            .remove(&self.id);
    }
}

impl ExecutionManager {
    pub fn available_capacity(&self) -> usize {
        let state = self.0.lock().unwrap();
        if state.stopping {
            0
        } else {
            4usize.saturating_sub(
                state.hub_workspaces.len() + state.sessions.values().filter(|s| s.busy).count(),
            )
        }
    }

    pub fn reserve(&self, workspace: Option<std::path::PathBuf>) -> Result<ExecutionPermit> {
        let mut state = self.0.lock().unwrap();
        ensure!(
            !state.stopping
                && state.hub_workspaces.len() + state.sessions.values().filter(|s| s.busy).count()
                    < 4,
            "execution capacity reached"
        );
        if let Some(path) = &workspace {
            ensure!(
                !state
                    .hub_workspaces
                    .values()
                    .any(|v| v.as_ref() == Some(path))
                    && !state
                        .sessions
                        .values()
                        .any(|s| s.busy && &s.options.agent.workspace == path),
                "workspace already has an active execution"
            );
        }
        let id = Uuid::new_v4().to_string();
        state.hub_workspaces.insert(id.clone(), workspace);
        Ok(ExecutionPermit {
            manager: self.clone(),
            id,
        })
    }
    pub async fn dispatch(&self, _lease: pb::RunLease) -> Result<()> {
        bail!("Hub lease dispatch is not implemented; use explicit local native execution")
    }

    pub fn start_native(
        &self,
        config: NativeRunOptions,
        session_id: Option<String>,
        prompt: String,
    ) -> Result<LocalRun> {
        ensure!(!prompt.trim().is_empty(), "prompt must not be empty");
        let options = config.resolve()?;
        let mut state = self.0.lock().unwrap();
        ensure!(!state.stopping, "daemon is stopping");
        // shortcut: 本地历史只存内存且有总量上限；接入 Hub 时改用 SQLite outbox。
        ensure!(
            state.runs.len() < 128 && state.history_bytes < 32 * 1024 * 1024,
            "local history limit reached; restart daemon after saving results"
        );
        ensure!(
            state.sessions.values().filter(|s| s.busy).count() + state.hub_workspaces.len() < 4,
            "native execution capacity reached"
        );
        ensure!(
            !state
                .sessions
                .values()
                .any(|s| s.busy && s.options.agent.workspace == options.agent.workspace),
            "workspace already has an active execution"
        );
        ensure!(
            !state
                .hub_workspaces
                .values()
                .any(|p| p.as_ref() == Some(&options.agent.workspace)),
            "workspace already has an active execution"
        );
        let session_id = if let Some(id) = session_id {
            let session = state
                .sessions
                .get(&id)
                .context("unknown local session; it is not a native thread ID or file path")?;
            ensure!(
                serde_json::to_value(&session.options.agent)?
                    == serde_json::to_value(&options.agent)?,
                "session provider, workspace and native options must match"
            );
            ensure!(!session.busy, "session is already running");
            id
        } else {
            ensure!(state.sessions.len() < 32, "local session limit reached");
            let id = format!("local-session-{}", Uuid::new_v4());
            state.sessions.insert(
                id.clone(),
                SessionEntry {
                    backend: Some(NativeBackend::new(options.clone())),
                    options: options.clone(),
                    busy: false,
                },
            );
            id
        };
        let session = state.sessions.get_mut(&session_id).unwrap();
        let mut backend = session.backend.take().context("session is unavailable")?;
        session.busy = true;
        let run = LocalRun {
            run_id: format!("local-{}", Uuid::new_v4()),
            attempt_id: Uuid::new_v4().to_string(),
            session_id: session_id.clone(),
            provider: options.agent.kind.as_str().into(),
            state: "dispatched".into(),
            cancel_requested: false,
            native_session_id: backend.control_handle().native_id(),
            last_sequence: 0,
            error: None,
        };
        backend.prepare(pb::AttemptRef {
            run_id: run.run_id.clone(),
            attempt_id: run.attempt_id.clone(),
        });
        let control = backend.control_handle();
        state.runs.insert(
            run.run_id.clone(),
            RunEntry {
                snapshot: run.clone(),
                events: vec![],
                control,
                task: None,
                overflow: false,
            },
        );
        let lease = pb::RunLease {
            run: Some(pb::Run {
                id: run.run_id.clone(),
                attempt_id: run.attempt_id.clone(),
                session_id,
                ..Default::default()
            }),
            prompt,
            ..Default::default()
        };
        let manager = self.clone();
        let run_id = run.run_id.clone();
        let task = tokio::spawn(async move {
            manager.execute_local(run_id, backend, lease).await;
        });
        state.runs.get_mut(&run.run_id).unwrap().task = Some(task);
        Ok(run)
    }

    async fn execute_local(&self, run_id: String, mut backend: NativeBackend, lease: pb::RunLease) {
        let (tx, mut rx) = mpsc::channel(32);
        let result = {
            let execute = backend.execute(&lease, tx);
            tokio::pin!(execute);
            let mut open = true;
            loop {
                tokio::select! {
                    biased;
                    event = rx.recv(), if open => match event {
                        Some(event) => self.record(&run_id, event),
                        None => open = false,
                    },
                    result = &mut execute => {
                        while let Ok(event) = rx.try_recv() { self.record(&run_id, event); }
                        break result;
                    }
                }
            }
        };
        let mut state = self.0.lock().unwrap();
        let entry = state.runs.get_mut(&run_id).unwrap();
        entry.snapshot.native_session_id = entry.control.native_id();
        if let Err(error) = result {
            entry.snapshot.state = "failed".into();
            entry.snapshot.error = Some(format!("{error:#}"));
        } else if let Some(event) = entry.events.last().filter(|e| e.event["type"] == "result") {
            entry.snapshot.state = event.event["state"].as_str().unwrap().into();
        }
        if entry.overflow {
            entry.snapshot.state = "failed".into();
            entry.snapshot.error =
                Some("local event history exceeded 32 MiB; execution stopped".into());
        }
        if !terminal(&entry.snapshot.state) {
            entry.snapshot.state = "failed".into();
            entry.snapshot.error = Some("native execution ended without a result".into());
        }
        let session_id = entry.snapshot.session_id.clone();
        let session = state.sessions.get_mut(&session_id).unwrap();
        session.busy = false;
        session.backend = Some(backend);
    }

    fn record(&self, run_id: &str, event: pb::ExecutionEvent) {
        log_execution_event(&event);
        let mut state = self.0.lock().unwrap();
        let event = local_event(event);
        let bytes = serde_json::to_vec(&event).unwrap().len();
        let overflow = state.history_bytes + bytes > 32 * 1024 * 1024 || bytes > 12 * 1024 * 1024;
        let entry = state.runs.get_mut(run_id).unwrap();
        entry.snapshot.native_session_id = entry.control.native_id();
        match event.event["type"].as_str() {
            Some("state") => entry.snapshot.state = event.event["state"].as_str().unwrap().into(),
            Some("error") => {
                entry.snapshot.error = event.event["message"].as_str().map(String::from)
            }
            _ => {}
        }
        if overflow || entry.overflow {
            entry.overflow = true;
            entry.control.cancel();
        } else {
            entry.snapshot.last_sequence = event.sequence;
            entry.events.push(event);
            state.history_bytes += bytes;
        }
    }

    pub fn get(&self, run_id: &str) -> Option<LocalRun> {
        self.0
            .lock()
            .unwrap()
            .runs
            .get(run_id)
            .map(|e| e.snapshot.clone())
    }

    pub fn events(&self, run_id: &str, after: u64) -> Result<Vec<LocalEvent>> {
        let state = self.0.lock().unwrap();
        let entry = state.runs.get(run_id).context("local run not found")?;
        // 每次至多一条，避免工具快照或完整回答把 IPC 响应无限放大。
        Ok(entry
            .events
            .iter()
            .find(|e| e.sequence > after)
            .cloned()
            .into_iter()
            .collect())
    }

    pub fn command(&self, command: pb::ControlCommand) -> Result<pb::CommandAck> {
        let mut state = self.0.lock().unwrap();
        let attempt = command.attempt.as_ref().context("missing attempt")?;
        let entry = state
            .runs
            .get_mut(&attempt.run_id)
            .context("local run not found")?;
        ensure!(
            entry.snapshot.attempt_id == attempt.attempt_id,
            "stale or mismatched attempt"
        );
        let ack = entry.control.command(&command)?;
        match command.payload {
            Some(pb::control_command::Payload::Cancel(_)) => entry.snapshot.cancel_requested = true,
            Some(pb::control_command::Payload::InteractionReply(_))
                if !terminal(&entry.snapshot.state) =>
            {
                entry.snapshot.state = "running".into()
            }
            _ => {}
        }
        Ok(ack)
    }

    pub fn sessions(&self) -> Vec<crate::Session> {
        self.0
            .lock()
            .unwrap()
            .sessions
            .iter()
            .map(|(id, s)| crate::Session {
                id: id.clone(),
                agent_id: s.options.agent.kind.as_str().into(),
            })
            .collect()
    }

    pub async fn shutdown(&self) {
        let tasks: Vec<_> = {
            let mut state = self.0.lock().unwrap();
            state.stopping = true;
            state
                .runs
                .values_mut()
                .filter_map(|entry| {
                    entry.control.cancel();
                    entry.task.take()
                })
                .collect()
        };
        for task in tasks {
            let _ = task.await;
        }
    }
}

fn terminal(state: &str) -> bool {
    matches!(state, "completed" | "failed" | "cancelled")
}

fn state_name(state: i32) -> &'static str {
    match pb::RunState::try_from(state).unwrap_or_default() {
        pb::RunState::Queued => "queued",
        pb::RunState::Dispatched => "dispatched",
        pb::RunState::Running => "running",
        pb::RunState::WaitingInput => "waiting_input",
        pb::RunState::WaitingApproval => "waiting_approval",
        pb::RunState::Completed => "completed",
        pb::RunState::Failed => "failed",
        pb::RunState::Cancelled => "cancelled",
        _ => "unspecified",
    }
}

fn parse_json(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or(Value::Null)
}

pub(crate) fn log_execution_event(event: &pb::ExecutionEvent) {
    let Some(attempt) = &event.attempt else {
        return;
    };
    let run = &attempt.run_id;
    let id = &attempt.attempt_id;
    match &event.payload {
        Some(execution_event::Payload::State(value)) => eprintln!(
            "reind: run state run_id={run} attempt_id={id} state={}",
            value.state().as_str_name()
        ),
        Some(execution_event::Payload::Error(value)) => eprintln!(
            "reind: run error run_id={run} attempt_id={id} code={} message={:?}",
            value.code, value.message
        ),
        Some(execution_event::Payload::Result(value)) => eprintln!(
            "reind: run finished run_id={run} attempt_id={id} state={} execution_stopped={}",
            value.state().as_str_name(),
            value.execution_stopped
        ),
        _ => {}
    }
}

fn local_event(event: pb::ExecutionEvent) -> LocalEvent {
    let payload = match event.payload.unwrap() {
        execution_event::Payload::State(v) => json!({"type":"state","state":state_name(v.state)}),
        execution_event::Payload::Text(v) => {
            json!({"type":"text","item_id":v.item_id,"text":v.text,"complete":v.complete,"reasoning":v.reasoning})
        }
        execution_event::Payload::Tool(v) => {
            json!({"type":"tool","call_id":v.call_id,"name":v.name,"input":parse_json(&v.input_json),"output":parse_json(&v.output_json),"complete":v.complete,"is_error":v.is_error})
        }
        execution_event::Payload::Interaction(v) => {
            json!({"type":"interaction","interaction_id":v.interaction_id,"approval_required":v.approval_required,"method":v.method,"parameters":parse_json(&v.parameters_json)})
        }
        execution_event::Payload::Error(v) => {
            json!({"type":"error","code":v.code,"message":v.message})
        }
        execution_event::Payload::Usage(v) => {
            json!({"type":"usage","model":v.model,"input_tokens":v.input_tokens,"output_tokens":v.output_tokens,"cache_read_tokens":v.cache_read_tokens,"cache_write_tokens":v.cache_write_tokens})
        }
        execution_event::Payload::Result(v) => {
            json!({"type":"result","state":state_name(v.state),"output":v.output,"execution_stopped":v.execution_stopped})
        }
    };
    let attempt = event.attempt.unwrap();
    LocalEvent {
        run_id: attempt.run_id,
        attempt_id: attempt.attempt_id,
        sequence: event.sequence,
        event: payload,
    }
}
