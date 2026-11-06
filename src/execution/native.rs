//! 原生路径运行在 reind 进程内，直接管理子进程和 stdin/stdout；不启动 HTTP。

use a2alinker::{Options, native::AgentSession};
use anyhow::{Result, bail};
use async_trait::async_trait;
use rein_proto::hub::v1::{BackendKind, CommandAck, ControlCommand, ExecutionEvent, RunLease};
use tokio::sync::mpsc;

pub struct NativeBackend {
    pub options: Options,
    session: Option<Box<dyn AgentSession>>,
    capabilities: Vec<String>,
}

impl NativeBackend {
    pub fn new(options: Options) -> Self {
        Self {
            options,
            session: None,
            capabilities: Vec::new(),
        }
    }

    pub fn session(&mut self) -> Option<&mut (dyn AgentSession + 'static)> {
        self.session.as_deref_mut()
    }

    pub async fn native_control(
        &mut self,
        _operation: &str,
        _payload: serde_json::Value,
    ) -> Result<()> {
        // TODO: 按已声明能力校验后调用 Codex/Pi 专属控制，支持 steer 等原生操作。
        // 不将任意 JSON 当成授权，也不让 A2A 的能力集合限制这里的实现。
        bail!("native control is not implemented (framework stage)")
    }
}

#[async_trait]
impl super::Backend for NativeBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Native
    }
    fn capabilities(&self) -> &[String] {
        &self.capabilities
    }

    async fn execute(
        &mut self,
        _lease: &RunLease,
        _events: mpsc::Sender<ExecutionEvent>,
    ) -> Result<()> {
        // TODO: 用 a2alinker::native::create_session(AdapterContext, native_id) 创建/恢复。
        // 返回的 session 由 reind 持有；run() 消费原生事件和审批回复通道。
        // Codex: app-server --listen stdio://；Pi: --mode rpc；不经过 Server/Gateway。
        // TODO: 转换 AgentEvent，保留 item/call/interaction ID、增量与完整快照语义。
        bail!("native execution is not implemented (framework stage)")
    }

    async fn control(&mut self, _command: &ControlCommand) -> Result<CommandAck> {
        // TODO: 关联当前 attempt/interaction，审批显式回复；取消须确认工具和进程清理。
        bail!("native interaction is not implemented (framework stage)")
    }
}
