# rein

Rust daemon 与 CLI 骨架，支持 macOS / Linux，Rust 1.89+。

- `reind`：前台运行的 daemon，持有 agent、session 和 A2A 服务注册表。
- `rein`：管理 `reind` 的后台进程，通过本地 Unix socket 查询 daemon。

## 构建与运行

```sh
cargo build
./target/debug/rein daemon start
./target/debug/rein daemon status
./target/debug/rein agents list
./target/debug/rein sessions list
./target/debug/rein a2a list
./target/debug/rein a2a inspect coder
./target/debug/rein daemon stop
```

安装两个二进制：

```sh
cargo install --path . --locked
```

`rein daemon start` 从自身所在目录启动 `reind`，因此两个二进制需放在同一目录。
也可直接运行 `reind`，由外部进程管理器托管。
重复 start / stop 均可安全执行；status 在未运行时输出 stopped，退出码为 0。
查询失败（包括 daemon 未运行、服务不存在）退出码非 0。

## 本地状态与通信

默认使用 `~/.rein/`，可通过 `REIN_HOME` 指定独立目录：

```sh
REIN_HOME=/tmp/rein-dev ./target/debug/rein daemon start
REIN_HOME=/tmp/rein-dev ./target/debug/rein daemon stop
```

目录权限设为 `0700`，包含 `reind.sock`、`daemon.lock` 和后台启动日志 `daemon.log`。
`REIN_HOME` 应指向 rein 专用目录，所有命令应使用同一目录。
文件锁防止同一目录启动多个 daemon；进程异常退出后，下一次启动会清理残留 socket。
停止通过 IPC 完成，不依赖 PID 文件或向 PID 发送信号。

当前协议为每连接一条请求、一条响应的换行分隔 JSON，消息上限 64 KiB，读写超时 2 秒。
例如 `agents list` 发送 `{"command":"agents_list"}`，收到
`{"type":"agents","agents":[]}`，CLI 输出 JSON 数组。
该协议尚未承诺版本兼容。

## 扩展位置

- `src/lib.rs`：请求、响应及 Agent / Session / A2aService 数据结构，IPC 客户端。
- `src/daemon.rs`：daemon 生命周期、内存注册表 `State`、请求分发。
- `src/bin/rein.rs`：命令树、后台启动及 CLI 输出。
- `src/bin/reind.rs`：daemon 入口。

目前注册表为空，三个 list 返回 `[]`，inspect 返回服务不存在。
尚未接入真实 agent、会话发现、持久化或 A2A HTTP 服务。
接入时由适配器填充 `State`；inspect 按服务 name 查找。
当前串行处理请求，适配器开始执行耗时任务时再增加并发。
Ctrl-C / SIGTERM 使用系统默认行为终止进程，残留 socket 会在下次启动恢复。
不包含开机自启、日志轮转及 Windows 支持。

## 检查

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --all-targets
```

## 第一阶段：Hub 与双 Backend 框架

目标链路：

```text
rein CLI → Unix socket IPC → reind → gRPC / TLS → Go reinhub
reind → Native Backend → stdin/stdout → Codex / Pi 子进程
reind → A2A Backend → HTTP/A2A → 独立 Agent 服务（包括 a2alinker）
```

开发需并排检出 `../proto` 和 `../a2alinker`；依赖生成的 `rein-proto` crate，并通过 `a2alinker::native` 在 reind 进程内复用原生适配代码。Native 不启动 a2alinker HTTP 服务。发布前固定协议与原生执行库版本，移除本地 path。

- `src/hub.rs`：带证书验证的 gRPC/TLS Client；普通 RPC 与双向流分离，凭据不参与 Debug。
- `src/execution/mod.rs`：共用 Backend 与执行管理边界；Native/A2A 文件分别预留协议与专属控制。
- `src/store.rs`、`migrations/0001_execution.sql`：SQLite 会话映射、inbox/outbox 的设计；尚未执行迁移或接入读写。
- [协议架构](../proto/docs/architecture.md)、[交互语义](../proto/docs/semantics.md)。

新增 CLI 框架入口：

```sh
rein login --hub https://localhost:9011
rein login status
rein run agent-1 "分析项目结构"
rein runs get run-1
rein runs cancel run-1 --attempt attempt-1
rein runs reply run-1 --attempt attempt-1 --interaction interaction-1 --response '{"decision":"accept"}'
rein runs instruct run-1 --attempt attempt-1 "补充要求"
```

这些命令已走 IPC，但会明确报 `not implemented (framework stage)`。daemon 尚未启动 Hub 后台循环，不进行真实登录、领取或执行，也不伪造成功或自动审批。原有启停和查询命令继续可用。长任务调度、会话恢复、审批取消、持久化和端到端测试属于下一阶段。
