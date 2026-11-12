# 单机 Console 集成

当前 `local` 分支由 reind 提供 Console 和 API，不再经过 Hub。启动、配置、数据目录和开发步骤以 [README](../README.md) 为准。

- CLI 通过 Unix socket 管理 daemon 和 JSON Agent 配置。
- Console 经同源 HTTP 发起执行、审批、取消及项目保存；SSE 提供事件更新。
- Agent 配置每次从 `.reind/agents/*.json` 读取，项目保存在 `.reind/projects/`。
- SQLite 只保存对话、事件和执行恢复数据，不保存 Agent 配置。
- 原生 Pi/Codex 由 reind 内嵌的 a2alinker 库启动，远程 Agent 走 A2A 1.0 JSON-RPC。

`cargo test` 验证完整 daemon/原生/A2A 闭环；`console` 中的 Playwright 测试验证真实 reind 页面及桌面/移动端布局。原 Hub 集成留在 main 分支。
