//! 本地 SQLite 边界；保存执行映射与持久化 inbox/outbox，不替代 Hub 权威状态。

pub const SCHEMA: &str = include_str!("../migrations/0001_execution.sql");

pub struct LocalStore {
    pub path: std::path::PathBuf,
}

// TODO: 接入 SQLite，事务分配 sequence 并写入 outbox，提交后才发送。
// TODO: ACK 持久化后删已确认事件；命令 inbox 按 command_id 和内容去重。
// TODO: 启动恢复后先与 Hub 对账，不自动重跑未知结果的执行。
