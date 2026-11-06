//! 可选 A2A 路径：服务可以是本机/远程 a2alinker，也可以是其他兼容 Agent。

use anyhow::{Result, bail};
use async_trait::async_trait;
use rein_proto::hub::v1::{BackendKind, CommandAck, ControlCommand, ExecutionEvent, RunLease};
use tokio::sync::mpsc;

pub struct A2aBackend {
    pub service_url: String,
    capabilities: Vec<String>,
}

impl A2aBackend {
    pub fn new(service_url: String) -> Self {
        Self {
            service_url,
            capabilities: Vec::new(),
        }
    }
}

#[async_trait]
impl super::Backend for A2aBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::A2a
    }
    fn capabilities(&self) -> &[String] {
        &self.capabilities
    }

    async fn execute(
        &mut self,
        _lease: &RunLease,
        _events: mpsc::Sender<ExecutionEvent>,
    ) -> Result<()> {
        // TODO: Agent Card/凭据/版本校验 → SendMessage → 保存 contextId/taskId。
        // TODO: GetTask/订阅，支持 Message 直接结果，Artifact 增量/替换归一化。
        // 回执未知时只在服务有明确幂等保证时重投，不能自动重跑有副作用的请求。
        bail!("A2A execution is not implemented (framework stage)")
    }

    async fn control(&mut self, _command: &ControlCommand) -> Result<CommandAck> {
        // TODO: 按远端能力取消/回复/扩展；断开 HTTP 不代表远端 Task 已停止。
        bail!("A2A interaction is not implemented (framework stage)")
    }
}
