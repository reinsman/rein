# Console → Hub → daemon → Agent 本机验证

默认 Console 的 Agent 列表来自 Hub。原生 Codex/Pi 由 reind 直接管理子进程；A2A 服务由独立 Backend 调用。两条路径共用平台 Run、attempt、执行事件及控制命令。

## 1. 启动 Hub

```sh
cd /Users/xhb/github/reinsman/reinhub
go run ./cmd/server -conf bin/conf.toml
```

当前 Hub 暂不接入登录，只接受数字 loopback 监听地址：HTTP `127.0.0.1:9010`、gRPC/TLS `127.0.0.1:9011`。首次启动在当前用户的 `~/.reinhub/` 生成本机 CA、服务端证书及私钥。默认通过 `--ca` 显式信任该 CA 并校验证书；也可显式选择下文的跳过校验模式。

数据目录省略或留空时默认使用 `~/.reinhub`，不受启动位置影响；配置 `directory` 可覆盖，支持 `~/` 展开。原 `.local-agents/` 数据不自动迁移；可保留旧路径配置继续使用。原 `[agent_development]` 段已移除，请删除 `enabled`，将 `directory` 放到 TOML 顶层、`[grpc]` 之前。

Hub 使用带文件锁的原子快照保存 Agent、Runtime、Run、事件、请求去重和控制回执，不要求 MySQL。事件写入、状态变更和累计 ACK 在同一次快照提交内完成。当前只有这一套单机实现，没有开发/生产模式切换，不依赖 MySQL。待 daemon 功能完备后再重构 Hub。

## 2. 启动 reind 并注册原生 Agent

```sh
cd /Users/xhb/github/reinsman/rein
cargo build --bins --locked
./target/debug/rein daemon start

./rein.sh up codex \
  --workspace /path/to/project \
  --hub https://localhost:9011 \
  --ca "$HOME/.reinhub/ca.pem"

./rein.sh up pi \
  --workspace /path/to/project \
  --hub https://localhost:9011 \
  --ca "$HOME/.reinhub/ca.pem"

./rein.sh ls
```

`--ca` 只为 reind 的 Hub 连接加载信任证书，**不会写入系统可信根证书目录**。如果希望无需分发 CA，可以显式选择：

```sh
./rein.sh up codex \
  --workspace /path/to/project \
  --hub https://localhost:9011 \
  --insecure-skip-verify
```

Codex、Pi 和 A2A 注册均支持 `--insecure-skip-verify`，它与 `--ca` 互斥。连接仍使用 TLS，但跳过服务端证书链、有效期和主机名校验，无法验证 Hub 身份。默认不开启，也不会在证书错误后自动降级；当前仍只允许 loopback Hub，不允许明文 HTTP。

该设置属于当前 daemon 的 Hub 连接，所有已注册 Agent 共用，保存在本地 SQLite，重连和重启后继续生效。重新注册时指定 `--ca /path/to/ca.pem` 可恢复校验；更新配置后后台连接重新建立。不影响 Agent 的模型连接或 A2A Backend 的 TLS 校验。

可用 `--name` 定义显示名，`--executable` 指定 CLI，`--native-config` 指定原生配置目录，`--model` 覆盖模型。工作目录和路径由 CLI 按调用位置解析。默认使用 Agent 自身的模型凭据、技能、扩展和审批策略。

如果 Pi 安装在 nvm 下，可在原生注册时添加 `--prepare 'source "$HOME/.nvm/nvm.sh" --no-use && nvm use --silent 24.20.0'`（版本按本机安装情况填写）。环境准备和进程启动仍在 reind 的 Native Backend 中通过共享库完成，不经过 HTTP。修改已有注册的准备命令后，请在 Console 新建对话。

注册命令经过 Unix socket，由 reind 保存配置、通过 gRPC 注册 Runtime 和 Agent，并建立 Hello/对账/后台领取连接。同名注册保留稳定 ID；切换配置时旧会话停止续接，请新建会话验证新配置。有已领取或活动 Hub 执行时拒绝变更。一个 `REIN_HOME` 绑定一个 Hub；可设置独立 `REIN_HOME` 隔离多个本机环境。

## 3. 可选：注册 A2A Agent

Agent 的上线/下线使用 `rein up` / `rein down`，列表使用 `rein ls`。例如 `./rein.sh down pi`、`./rein.sh up pi`。后者不带配置选项时保留工作目录、nvm、模型和连接设置。下线不删除会话/历史，也不强制中止任务；Hub 有未结束 Run 时拒绝下线。Hub 不可达时 daemon 保留待同步意图，恢复连接后继续下线，重启不把它重新发布为在线。原 `register agent` 与 `agents list` 仍兼容。

先启动一个真实的独立服务，例如 a2alinker：

```sh
cd /Users/xhb/github/reinsman/a2alinker
cargo build --bins --locked
./target/debug/a2alinker serve --name pi-service --desc '本机 Pi 服务' \
  --agent pi --workspace /path/to/project --listen 127.0.0.1:10100
```

然后注册服务地址：

```sh
cd /Users/xhb/github/reinsman/rein
./rein.sh up a2a --name pi-a2a \
  --url http://127.0.0.1:10100 \
  --hub https://localhost:9011 \
  --ca "$HOME/.reinhub/ca.pem"
```

A2A 当前支持 v1 JSON-RPC 的 Agent Card 发现、SendMessage（含直接 Message 结果）、GetTask 快照轮询、CancelTask、context 续接和普通 InputRequired 文本回复。支持 `urn:a2alinker:interaction:v1` 的服务可传递结构化审批/表单回复；工具事件按服务扩展提供。尚未实现 A2A SSE 订阅、HTTP+JSON/gRPC transport 或旧版 0.3 payload。

若需要 Bearer 凭据，启动 daemon 的环境中提供一个独立变量，然后注册时添加 `--token-env A2A_SERVICE_TOKEN`。仅保存变量名，凭据不进入 Hub；跨 origin 的 Agent Card 地址不能接收这个凭据。Hub 的连接凭据和模型凭据分别管理。

## 4. 启动 Console

```sh
cd /Users/xhb/github/rein-console
npm install
npm run dev -- --host 127.0.0.1
```

打开终端显示的 Vite 地址（默认 `http://127.0.0.1:5173`），不经过登录页。

- 打开页面即请求 `/api/agents`，Vite 代理到 Hub；列表自动刷新，区分原生/A2A与在线/离线。
- 选择 Agent 后发送消息，Hub 创建 queued Run，daemon 按容量领取并建立 attempt。
- daemon 先写 SQLite 检查点和启动事件，取得 Hub 持久化 ACK 后才调用 Backend。
- 页面通过 HTTP 加载当前会话最近 20 轮，上滚时按游标加载更早历史并保持阅读位置；实时文本、公开思考摘要、工具、交互和权威状态通过 SSE 推送。完整文本与工具快照按 ID 替换，避免重复拼接。
- 原生审批和 Pi 扩展表单可在面板里回复；回复绑定 run/attempt/interaction。跨任务、过期或重复回复会被拒绝。
- 停止操作先保存取消意图，等待原生进程清理或远端 Task 确认后才显示已取消。排队→领取的竞态通过刷新最新 attempt 处理，不绕过 fencing。
- “新对话”创建新的平台 Session；现有会话可继续。页面刷新后从 Hub 恢复执行记录及当前会话。
- daemon 离线不改变已记录的执行结果。Hub 断线时，daemon 保留执行并将事件写入 SQLite outbox，重连对账后重传。

Console 的 Run 面板不再定时请求列表或事件。首次 HTTP 响应提供 SSE 提交游标，覆盖查询与建连之间的更新；重连通过 Last-Event-ID 补发增量，按 run/attempt/sequence 去重，按持久化版本号合并状态。SSE 与 daemon→Hub 的 gRPC 流彼此独立。分页和 curl 验证见 [Hub 测试文档](../../reinhub/TESTING.md#6-http-历史分页与-sse-实时增量)。

代理目标可通过 `REIN_HUB_HTTP=http://127.0.0.1:9010` 配置。生产静态部署需要在同源反向代理上配置 `/api`，Vite proxy 仅用于开发。

## 数据与边界

- Hub `~/.reinhub/hub-state.json` 是当前实现的权威数据，最多 512 个 Run、64 MiB 快照；多实例部署需替换为模板的事务数据库。
- daemon 的 `REIN_HOME/reind.sqlite` 保存注册、稳定 daemon ID、平台与原生/A2A会话映射、领取请求、事件 outbox 与控制 inbox。
- 正常退出会取消活动任务并保存终态；重启不重跑旧执行。执行中被强制杀死时，结果未知的 Agent 被阻止再次自动执行，需要先人工检查和清理进程。
- 原生会话历史由 Codex/Pi 保存；通过已确认的 session 映射恢复上下文。A2A 的 contextId/taskId 分别保存。
- 登录、生产权限、凭据签发/续期、生产数据库迁移、未知执行的人工恢复工具、执行中的 steer/追加指令、用量采集尚未实现。
- `rein native run` 的独立本地模式继续可用，其历史仍只在内存中。平台 `rein run` 等旧 CLI 框架入口尚未接线，当前 Hub 交互通过 Console 验证。

## 自动化验证

不访问模型服务；通过实际子进程管道和真实 HTTP/gRPC/TLS 链路运行确定性协议 fixture，需要 Python 3。

```sh
cd /Users/xhb/github/reinsman/reinhub
go build -o /tmp/reinhub-dev-console ./cmd/server
cd ../a2alinker
cargo build --bins --locked
cd ../rein
cargo build --bins --locked
python3 tests/hub_stack.py
# 另外验证跳过校验、错误 CA 拒绝与重启恢复
python3 tests/hub_stack.py --insecure-skip-verify

cd /Users/xhb/github/rein-console
npm run test:hub
```

脚本使用独立临时目录和端口。浏览器测试验证 Console → Hub → reind → 原生 Codex/Pi 或独立 a2alinker 服务；覆盖多轮、审批、取消、页面刷新、错误反馈和窄屏布局。Python 链路测试还覆盖 daemon 重启后的稳定注册/会话恢复，以及 Hub 重启后的活动审批与事件对账。

已有前端演示保留在显式 `VITE_REIN_MODE=demo npm run dev` 模式，原来的演示 UI 测试使用独立 5175 端口。它不会混入默认的真实 Agent 列表。
