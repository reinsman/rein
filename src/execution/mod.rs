//! 共用基础事件与执行管理；高级控制留在具体 Backend，不限制原生能力。
pub mod a2a;
pub mod native;

use anyhow::{Result, bail};
use async_trait::async_trait;
use rein_proto::hub::v1::{BackendKind, CommandAck, ControlCommand, ExecutionEvent, RunLease};
use tokio::sync::mpsc;

#[async_trait]
pub trait Backend: Send {
    fn kind(&self) -> BackendKind;
    // 注册时只声明实际探测且已实现的能力；框架阶段不宣称可执行。
    fn capabilities(&self) -> &[String];
    async fn execute(
        &mut self,
        lease: &RunLease,
        events: mpsc::Sender<ExecutionEvent>,
    ) -> Result<()>;
    async fn control(&mut self, command: &ControlCommand) -> Result<CommandAck>;
}

#[derive(Default)]
pub struct ExecutionManager;

impl ExecutionManager {
    pub async fn dispatch(&self, _lease: RunLease) -> Result<()> {
        // TODO: 校验 attempt、保存映射和启动事件；收到 Hub 持久化 ACK 后再启动。
        // TODO: 按 Runtime 选择 Native/A2A；事件先写 SQLite outbox，再由 Hub 流上报。
        // TODO: 并发容量、会话串行化、审批关联、取消确认和关闭清理由这里收口。
        bail!("execution dispatch is not implemented (framework stage)")
    }
}
