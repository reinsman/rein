# rein

Rust 本地 daemon 与 CLI，支持 macOS / Linux、Rust 1.89+。

```text
rein CLI → Unix socket IPC → reind
                              ├ Native Backend → stdin/stdout → Codex / Pi 子进程
                              ├ A2A Backend → HTTP/A2A → Agent 服务
                              └ gRPC / TLS → reinhub
```

原生适配器通过 `a2alinker::native` Rust 库运行在 **reind 进程内**。由 reind 启动 Agent、持有管道、处理事件及交互、清理进程，不启动 a2alinker HTTP 服务。

## 构建与运行

开发时并排检出 `../proto`、`../a2alinker`：

```sh
./build.sh
./run.sh
./rein.sh daemon status
./stop.sh
```

`build.sh` 构建 `target/debug/rein` 和 `reind`；`run.sh` 后台启动 daemon，`stop.sh` 通过 IPC 停止。脚本从自身位置定位二进制，可在其他目录调用；启停脚本保留调用时的工作目录。默认日志为 `~/.rein/daemon.log`，设置 `REIN_HOME` 时启停及其他 CLI 命令需保持一致。

`rein.sh` 是 `target/debug/rein` 的快捷入口，原样转发所有子命令和参数，并保留调用时的工作目录：

```sh
./rein.sh ls
./rein.sh up pi --workspace "$PWD" --ca "$HOME/.reinhub/ca.pem"
./rein.sh native run codex "分析项目结构" --workspace "$PWD"
```

也可 `cargo install --path . --locked`。`rein daemon start` 从自身所在目录启动 `reind`，两个二进制需放在同一目录；也可直接运行 `reind`。

## Agent 上下线

首次 `up` 负责配置并上线，参数与原 `register agent` 相同；不带配置选项时复用已保存的完整配置和 Hub 连接设置：

```sh
./rein.sh up pi --workspace "$PWD" --ca "$HOME/.reinhub/ca.pem"
./rein.sh down pi
./rein.sh up pi
./rein.sh ls

# 自定义名字及 A2A 服务
./rein.sh up a2a --name pi-service --url http://127.0.0.1:10100 --ca "$HOME/.reinhub/ca.pem"
./rein.sh down pi-service
./rein.sh up a2a --name pi-service
```

`down` 接受名称或 Agent ID；重复下线可安全执行。有 queued、执行中或等待交互的任务时拒绝下线，需先完成或取消。下线保留配置、稳定 ID、会话和执行历史；Hub 列表仍显示该 Agent，但 `disabled=true`、`online=false`，不接受或领取新任务。裸 `up pi` 会保留已有 nvm、模型和工作目录；指定配置选项时视为完整配置更新，仍需显式提供 `--ca` 或 `--insecure-skip-verify`。原 `register agent` 和 `agents list` 保持兼容。

daemon 先保存下线意图，再联系 Hub；确认前不返回成功。暂时连接失败时保留意图，重连或重启后重试，期间不重新发布或领取该 Agent；明确的权限/忙碌等拒绝会恢复本地启用状态。`ls.disabled` 是本地期望状态，实际可用性以 Hub 列表为准。下线不停止独立 A2A 服务，也不删除原生会话文件。daemon 启停仍使用 `daemon start/stop` 或 `run.sh/stop.sh`。

## 本地原生执行

先安装并配置 Codex / Pi 及其模型凭据。默认沿用 Agent 自身的配置、技能、扩展和审批策略，不自动批准交互，也不修改其安全配置。

```sh
rein native run codex "分析项目结构" --workspace "$PWD"
rein native run pi "分析项目结构" --workspace "$PWD"
```

命令立即返回本地 `run_id`、`attempt_id`、`session_id`，不等待模型完成。它是显式的本地执行入口，不创建 Hub Run，也不要求先登录 Hub。ID 以 `local-` 开头，与平台任务分开。

可选参数：`--executable /path/to/codex`、`--native-config /path/to/config-dir`、`--model MODEL`。相对路径由 CLI 按调用位置解析，工作目录不会沿用 daemon 启动时的位置。

Agent 安装在 nvm 等环境中时，注册和本地执行都支持 `--prepare`。准备命令在每次启动 Agent 前由 Bash 执行，其导出的环境传给子进程；无需让 daemon 加载交互终端配置：

```sh
./rein.sh up pi --workspace "$PWD" --ca "$HOME/.reinhub/ca.pem" \
  --prepare 'source "$HOME/.nvm/nvm.sh" --no-use && nvm use --silent 24.20.0'
./rein.sh native run pi "分析项目结构" --workspace "$PWD" \
  --prepare 'source "$HOME/.nvm/nvm.sh" --no-use && nvm use --silent 24.20.0'
```

Node 版本按本机安装情况填写。该配置保存在 daemon 的原生注册中，重启后继续生效；准备输出写入 Agent 的 stderr，不污染协议 stdout。准备命令执行失败时不会继续启动 Agent。A2A Backend 的环境由独立服务管理，不能在 A2A 注册中使用此参数。

```sh
rein runs get RUN_ID
rein runs events RUN_ID --follow
rein runs events RUN_ID --after 3
rein sessions list

# 同一平台本地 session 开始下一轮；provider、workspace、原生选项必须一致
rein native run codex "继续分析" --workspace "$PWD" --session SESSION_ID

rein runs reply RUN_ID --attempt ATTEMPT_ID --interaction INTERACTION_ID \
  --response '{"decision":"accept"}'
# Pi confirm 交互示例；其他表单按 interaction.parameters 填写
rein runs reply RUN_ID --attempt ATTEMPT_ID --interaction INTERACTION_ID \
  --response '{"confirmed":true}'
rein runs cancel RUN_ID --attempt ATTEMPT_ID
```

- Codex 使用 `app-server --listen stdio://`，执行 initialize、thread/start 或 thread/resume、turn/start；审批请求保留原生请求 ID 映射，取消使用 turn/interrupt。
- Pi 使用 `--mode rpc`，执行 get_state、prompt，消费执行事件；取消使用 clear_queue / abort。prompt 响应只代表接受，等待 agent_settled（或兼容的旧版 agent_end）才判定结束。
- 执行事件使用共享 Protobuf `ExecutionEvent`，携带 `(run_id, attempt_id, sequence)`；本地 IPC 将其映射为 JSON。sequence 每个 attempt 从 1 开始；单次 events 返回至多一条，`--after` 可重复查询，`--follow` 连续输出 JSONL。
- 文本 `complete=false` 代表增量，`complete=true` 是完整替换；工具输出为同一 call_id 的快照。公开思考以 `reasoning=true` 表达；不转发隐藏推理或签名。用量事件结构已预留，当前适配器尚未采集。
- 审批等待不会阻塞 IPC；回复必须匹配 run/attempt/interaction，并通过原生格式校验。不支持的操作明确拒绝；本轮未实现执行中的追加指令、steer 等高级控制。
- 控制返回 `received` 表示请求已接收，取消须等待 Run 的 `cancelled` 及最终事件 `execution_stopped=true`。原生中断超时后强制清理进程组，等待直接子进程退出。握手中断等结果未知的情况标为 failed，不伪报取消成功。
- 每轮结束均关闭 Agent 进程，下一轮通过 Codex thread ID / Pi session 文件恢复，不在后台保留空闲子进程。同一工作目录只允许一个执行，全局最多四个。

## 本地状态与退出

默认使用 `~/.rein/`，可用 `REIN_HOME` 指定专用目录，所有命令保持一致。目录权限 `0700`，socket `0600`，包含 `reind.sock`、`daemon.lock`、`daemon.log`。文件锁防止重复启动；启动时清理残留 socket，但保留同名普通文件。

后台运行时，`daemon.log` 接收标准输出和错误输出，包含启动、停止、Run 状态、结果和错误信息，并带 run_id / attempt_id。提示词、文本增量、工具内容及准备命令不作为过程日志输出。实时查看：

```sh
tail -n 100 -F "${REIN_HOME:-$HOME/.rein}/daemon.log"
```

```sh
rein daemon stop
```

stop、SIGINT、SIGTERM 会先停止接收连接、取消活动执行并清理 Agent，再退出。CLI 退出或停止跟随事件不会取消任务。SIGKILL/掉电不运行清理逻辑，无法保证 Agent 及其自行脱离进程组的工具被清理。

独立 `rein native run` 的 Run、session 映射及事件只存内存，重启后丢失，**不会自动重跑**。原生历史仍由 Agent 保存在其配置目录。Hub 模式另用 SQLite 持久化，见下文。内存历史最多 128 个 Run、32 个 session、共 32 MiB；超限明确报错或停止执行，保存所需结果后可重启清空。

IPC 为每连接一条 JSON 请求/响应，使用异步并发处理；请求上限 64 KiB，响应上限 16 MiB，普通读写超时 2 秒，stop 等待清理最多 20 秒。本地协议尚未承诺版本兼容。

## Console / Hub 本机闭环

已实现 `rein up codex|pi|a2a`（兼容 `register agent`） → IPC → reind 注册 → gRPC/TLS → reinhub → Console Agent 列表。面板可发起执行、续接会话、查看执行事件、回复审批/表单并取消。当前 Hub 暂不接入登录，只支持 loopback 监听；没有开发/生产模式切换。

Hub 默认校验证书。`--ca` 仅为 reind 加载 CA，不修改系统信任目录；注册时可显式使用 `--insecure-skip-verify` 跳过 Hub 身份校验，仍保留 TLS 加密。两者互斥，设置在重连和重启后保持。

[完整启动、注册与验收步骤](docs/console-integration.md)。`src/hub_runtime.rs` 管理注册、领取、重连、执行与控制；`src/store.rs` 和迁移接入 SQLite inbox/outbox。`agents list` 展示 daemon 保存的注册，`sessions list` 仍只展示独立本地执行会话。

`rein login`、平台 `rein run` 等旧 CLI 框架入口尚未接线；当前平台操作通过 Console 验证。高级 steer/追加指令、用量采集和生产认证/数据库实现留待后续。


## 检查

可复制的原生 CLI、Hub 注册和独立 A2A curl 用例见 [CLI / A2A 测试文档](docs/cli-a2a-testing.md)。

```sh
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --all-targets --locked
```

集成测试经真实 CLI → IPC → reind → 原生子进程管道执行；复用 a2alinker 的确定性协议 fixture，需要 Python 3，不访问模型服务。覆盖流式文本、会话恢复、交互校验、取消与超时、异常协议、主进程崩溃、工具进程清理、daemon 停止及 IPC 并发。

未包含开机自启、日志轮转及 Windows 支持。发布前应将本地 path 依赖固定为协议与适配库版本。
