//! 共用执行事件；原生和远程 A2A 使用同一 Backend。
pub mod a2a;
mod a2a_client;
pub mod native;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use anyhow::{Result, ensure};
use async_trait::async_trait;
use rein_proto::hub::v1::{self as pb, execution_event};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use uuid::Uuid;

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
    #[serde(default)]
    pub finished_at: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalEvent {
    pub run_id: String,
    pub attempt_id: String,
    pub sequence: u64,
    pub event: Value,
}

// Native agents sharing a directory must not write to it concurrently.
#[derive(Clone, Default)]
pub struct ExecutionManager(Arc<Mutex<HashMap<String, Option<std::path::PathBuf>>>>);
pub struct ExecutionPermit {
    manager: ExecutionManager,
    id: String,
}
impl Drop for ExecutionPermit {
    fn drop(&mut self) {
        self.manager.0.lock().unwrap().remove(&self.id);
    }
}
impl ExecutionManager {
    pub fn reserve(&self, directory: Option<std::path::PathBuf>) -> Result<ExecutionPermit> {
        let mut active = self.0.lock().unwrap();
        ensure!(active.len() < 4, "execution capacity reached");
        if let Some(path) = &directory {
            ensure!(
                !active.values().any(|d| d.as_ref() == Some(path)),
                "directory already has an active execution"
            );
        }
        let id = Uuid::new_v4().to_string();
        active.insert(id.clone(), directory);
        Ok(ExecutionPermit {
            manager: self.clone(),
            id,
        })
    }
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

pub(crate) fn local_event(event: pb::ExecutionEvent) -> LocalEvent {
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
