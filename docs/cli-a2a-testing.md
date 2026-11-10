# rein CLI 与 A2A curl 测试

本页使用已有确定性 fixture，不调用模型。需要 `jq`、`curl`、Python 3；命令按顺序在 bash/zsh 执行。Hub 的 curl 用例见 [reinhub/TESTING.md](../../reinhub/TESTING.md)。

## 1. 本地原生 CLI：不依赖 Hub / A2A

在 rein 根目录构建，并使用独立 REIN_HOME，避免操作日常 daemon：

```sh
cargo build --bins --locked
export REIN_HOME=$(mktemp -d /tmp/rein-cli-test.XXXXXX)
CLI=./target/debug/rein
FIXTURE=$(cd ../a2alinker && pwd)/crates/a2alinker/tests/fixtures/fake_agent.py
mkdir -p "$REIN_HOME/workspace" "$REIN_HOME/pi-config" "$REIN_HOME/codex-config"
$CLI daemon start
$CLI daemon status

START=$($CLI native run pi hello --workspace "$REIN_HOME/workspace" \
  --executable "$FIXTURE" --native-config "$REIN_HOME/pi-config")
printf '%s\n' "$START" | jq .
RUN_ID=$(printf '%s' "$START" | jq -er '.run_id')
ATTEMPT_ID=$(printf '%s' "$START" | jq -er '.attempt_id')
SESSION_ID=$(printf '%s' "$START" | jq -er '.session_id')
$CLI runs events "$RUN_ID" --follow
$CLI runs get "$RUN_ID"
$CLI sessions list
```

预期 `Hello 1`、最终 `state:completed`。`native run` 立即返回；长任务不占用 IPC。CLI 本地 JSON 字段是 snake_case，事件位于 `.event`；本地 Run ID 以 `local-` 开头。普通 events 查询每次最多一条，必须推进 `--after`，或用 `--follow` 自动读取到终态。

继续同一原生会话，应输出 `Hello 2`：

```sh
START=$($CLI native run pi again --session "$SESSION_ID" --workspace "$REIN_HOME/workspace" \
  --executable "$FIXTURE" --native-config "$REIN_HOME/pi-config")
RUN_ID=$(printf '%s' "$START" | jq -er '.run_id')
$CLI runs events "$RUN_ID" --follow
```

审批与工具事件：

```sh
START=$($CLI native run pi approval --workspace "$REIN_HOME/workspace" \
  --executable "$FIXTURE" --native-config "$REIN_HOME/pi-config")
RUN_ID=$(printf '%s' "$START" | jq -er '.run_id')
ATTEMPT_ID=$(printf '%s' "$START" | jq -er '.attempt_id')
# 最多等待 15 秒，等到交互请求后才能回复。
AFTER=0
for poll in $(seq 1 75); do
  BATCH=$($CLI runs events "$RUN_ID" --after "$AFTER")
  INTERACTION_ID=$(printf '%s' "$BATCH" | jq -r '[.[] | select(.event.type == "interaction")] | last.event.interaction_id // empty')
  AFTER=$(printf '%s' "$BATCH" | jq -r --arg after "$AFTER" 'last.sequence // $after')
  if [ -n "$INTERACTION_ID" ]; then break; fi
  sleep 0.2
done
test -n "$INTERACTION_ID"
$CLI daemon status
$CLI runs reply "$RUN_ID" --attempt "$ATTEMPT_ID" --interaction "$INTERACTION_ID" --response '{"confirmed":true}'
$CLI runs events "$RUN_ID" --follow

START=$($CLI native run pi execution --workspace "$REIN_HOME/workspace" \
  --executable "$FIXTURE" --native-config "$REIN_HOME/pi-config")
RUN_ID=$(printf '%s' "$START" | jq -er '.run_id')
$CLI runs events "$RUN_ID" --follow
```

等待审批时 `daemon status` 仍应立即响应。`execution` 应展示公开思考、工具调用/结果及最终文本；同一工具的完整结果是替换快照。

取消：

```sh
START=$($CLI native run pi slow --workspace "$REIN_HOME/workspace" \
  --executable "$FIXTURE" --native-config "$REIN_HOME/pi-config")
RUN_ID=$(printf '%s' "$START" | jq -er '.run_id')
ATTEMPT_ID=$(printf '%s' "$START" | jq -er '.attempt_id')
$CLI runs cancel "$RUN_ID" --attempt "$ATTEMPT_ID"
$CLI runs events "$RUN_ID" --follow
$CLI runs get "$RUN_ID"
$CLI daemon stop
```

预期最终 `cancelled`，Result 的 `execution_stopped:true`。取消命令返回 received 不等于已停止。测试 Codex 时将 `pi` 改为 `codex`、配置目录改为 `codex-config`，审批回复改为 `{"decision":"accept"}`。

本地历史在 daemon 内存中，重启后不能查询。测试目录可保留排错；继续第 2 节时保留当前变量，全部测试完成后再 `unset REIN_HOME`。

## 2. 注册到 Hub

此节使用正常启动的 Hub（默认配置数据在 `~/.reinhub`）。上节 daemon 已停止；沿用第 1 节的 REIN_HOME、CLI 和 FIXTURE 变量，重新启动隔离的测试 daemon。

```sh
$CLI daemon start
$CLI up pi --workspace "$REIN_HOME/workspace" \
  --executable "$FIXTURE" --native-config "$REIN_HOME/pi-config" \
  --hub https://localhost:9011 --ca "$HOME/.reinhub/ca.pem"
$CLI up codex --workspace "$REIN_HOME/workspace" \
  --executable "$FIXTURE" --native-config "$REIN_HOME/codex-config" \
  --hub https://localhost:9011 --ca "$HOME/.reinhub/ca.pem"
$CLI ls
curl -fsS http://127.0.0.1:9010/api/agents | jq .
```

预期 Hub 与 CLI 显示相同 Agent ID。工作目录相同的两个原生 Agent 串行执行，属于当前保护规则。

没有活动 Hub 任务时验证上下线：

```sh
$CLI down pi
$CLI ls
curl -fsS http://127.0.0.1:9010/api/agents | jq '.agents[] | {name:.agent.name,disabled:.agent.disabled,online}'
$CLI up pi
$CLI ls
```

下线仍保留列表与历史，disabled 为 true、online 为 false；再次上线保留 Agent ID 和之前保存的原生配置。`down` 也接受 Agent ID；有任务排队、执行或等待交互时应返回错误。旧 `register agent` / `agents list` 入口仍可使用。配置更新带选项，裸 `up pi` 仅复用保存配置。

真实模型测试移除 `--executable "$FIXTURE"`，使用实际项目的 `--workspace`，按需移除测试 `--native-config`，由 Codex/Pi 使用自己的模型凭据；不会把 Hub 凭据传给模型。fixture 的 `hello/approval/slow` 指令没有真实模型语义。

`rein login`、`rein run` 和非 `local-` Run 的 CLI 控制目前仍是 framework 入口，会报未实现；平台 Run 请走 Hub curl / Console。`rein a2a list/inspect` 也不是已注册 A2A Backend 的清单，应使用 `rein agents list` / Hub 列表。

## 3. 独立 A2A 服务

另开终端，在 a2alinker 仓库执行；结束时按 Ctrl-C：

```sh
cd /Users/xhb/github/reinsman/a2alinker
cargo build --bins --locked
A2A_TEST_DIR=$(mktemp -d /tmp/rein-a2a-test.XXXXXX)
mkdir -p "$A2A_TEST_DIR/workspace" "$A2A_TEST_DIR/pi-config"
./target/debug/a2alinker serve --name pi-curl --desc 'Pi curl 验证' --agent pi \
  --workspace "$A2A_TEST_DIR/workspace" \
  --executable "$PWD/crates/a2alinker/tests/fixtures/fake_agent.py" \
  --agent-config "$A2A_TEST_DIR/pi-config" --storage-dir "$A2A_TEST_DIR/storage" \
  --listen 127.0.0.1:10100
```

在 curl 终端执行。Agent Card 宣告的 JSONRPC 地址为 `/a2a`；使用 A2A 1.0 方法名和数据结构，不混用 0.3 的 `message/send`、`role:user`、`kind:text`。

```sh
A2A_HTTP=http://127.0.0.1:10100
curl -fsS "$A2A_HTTP/.well-known/agent-card.json" | jq .
MESSAGE_ID=$(uuidgen)
SEND=$(jq -nc --arg id "$(uuidgen)" --arg message "$MESSAGE_ID" \
  '{jsonrpc:"2.0",id:$id,method:"SendMessage",params:{message:{messageId:$message,role:"ROLE_USER",parts:[{text:"hello"}]},configuration:{returnImmediately:true}}}')
RESPONSE=$(curl -fsS "$A2A_HTTP/a2a" -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' --data-binary "$SEND")
printf '%s\n' "$RESPONSE" | jq .
TASK_ID=$(printf '%s' "$RESPONSE" | jq -er '.result.task.id')
CONTEXT_ID=$(printf '%s' "$RESPONSE" | jq -er '.result.task.contextId')

# 相同 messageId 和内容重试，必须返回原 Task。
curl -fsS "$A2A_HTTP/a2a" -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' --data-binary "$SEND" |
  jq --arg task "$TASK_ID" -e '.result.task.id == $task'
```

JSON-RPC 业务错误可能仍是 HTTP 200，必须检查 `.error`；`curl -f` 只校验 HTTP。`SendMessage.result.task` 与 `GetTask.result` 的外层结构不同。

```sh
# 查询不创建任务、不调用模型。可重复查询直到 TASK_STATE_COMPLETED。
jq -nc --arg id "$(uuidgen)" --arg task "$TASK_ID" \
  '{jsonrpc:"2.0",id:$id,method:"GetTask",params:{id:$task}}' |
  curl -fsS "$A2A_HTTP/a2a" -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' --data-binary @- | jq .

# 先确认前一个 Task completed，再用原 contextId、新 messageId 继续。
jq -nc --arg id "$(uuidgen)" --arg message "$(uuidgen)" --arg context "$CONTEXT_ID" \
  '{jsonrpc:"2.0",id:$id,method:"SendMessage",params:{message:{messageId:$message,contextId:$context,role:"ROLE_USER",parts:[{text:"again"}]}}}' |
  curl -fsS "$A2A_HTTP/a2a" -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' --data-binary @- | jq .
```

fixture 第二轮回答 `Hello 2`。订阅或查看 SSE 是可选验证；reind 的 A2A Backend 当前使用 GetTask 轮询。

## 4. A2A 审批、取消与接入 reind

创建 Pi 审批任务；默认 SendMessage 等待输入或终态后返回，故无需猜测等待时间：

```sh
RESPONSE=$(jq -nc --arg id "$(uuidgen)" --arg message "$(uuidgen)" \
  '{jsonrpc:"2.0",id:$id,method:"SendMessage",params:{message:{messageId:$message,role:"ROLE_USER",parts:[{text:"approval"}]}}}' |
  curl -fsS "$A2A_HTTP/a2a" -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' --data-binary @-)
printf '%s\n' "$RESPONSE" | jq .
TASK_ID=$(printf '%s' "$RESPONSE" | jq -er '.result.task.id')
CONTEXT_ID=$(printf '%s' "$RESPONSE" | jq -er '.result.task.contextId')
INTERACTION_ID=$(printf '%s' "$RESPONSE" | jq -er '.result.task.metadata.pendingInteraction.id')
jq -nc --arg id "$(uuidgen)" --arg message "$(uuidgen)" --arg context "$CONTEXT_ID" \
  --arg task "$TASK_ID" --arg interaction "$INTERACTION_ID" \
  '{jsonrpc:"2.0",id:$id,method:"SendMessage",params:{message:{messageId:$message,contextId:$context,taskId:$task,role:"ROLE_USER",parts:[{data:{interactionId:$interaction,response:{confirmed:true}}}]}}}' |
  curl -fsS "$A2A_HTTP/a2a" -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' \
    -H 'A2A-Extensions: urn:a2alinker:interaction:v1' --data-binary @- | jq .

RESPONSE=$(jq -nc --arg id "$(uuidgen)" --arg message "$(uuidgen)" \
  '{jsonrpc:"2.0",id:$id,method:"SendMessage",params:{message:{messageId:$message,role:"ROLE_USER",parts:[{text:"slow"}]},configuration:{returnImmediately:true}}}' |
  curl -fsS "$A2A_HTTP/a2a" -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' --data-binary @-)
TASK_ID=$(printf '%s' "$RESPONSE" | jq -er '.result.task.id')
jq -nc --arg id "$(uuidgen)" --arg task "$TASK_ID" \
  '{jsonrpc:"2.0",id:$id,method:"CancelTask",params:{id:$task}}' |
  curl -fsS "$A2A_HTTP/a2a" -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' --data-binary @- | jq .
```

取消后按上一节 GetTask 查询，直到 `TASK_STATE_CANCELED`；HTTP 成功或取消请求收到并非最终停止确认。不要取消已终态 Task，服务会返回 JSON-RPC 错误。

将这个独立服务作为可选 Backend 注册（在仍保留 CLI 环境变量的终端执行）：

```sh
$CLI up a2a --name pi-a2a --url http://127.0.0.1:10100 \
  --hub https://localhost:9011 --ca "$HOME/.reinhub/ca.pem"
$CLI ls
curl -fsS http://127.0.0.1:9010/api/agents | jq .
```

随后从 Hub curl 或 Console 选择 pi-a2a 交互。这条路径经过 HTTP/A2A；原生注册仍直接使用子进程管道，不启动 a2alinker HTTP 服务。远程服务按实际 Agent Card 与认证方式配置，测试命令未覆盖第三方服务和真实模型。

## 5. 自动化与收尾

```sh
# rein 根目录
cargo test --all-targets --locked
python3 tests/hub_stack.py
# 上述 CLI 注册测试完成后，停止独立测试 daemon。
$CLI daemon stop
unset REIN_HOME
```

Python 栈会隔离自己的 REIN_HOME，不修改手工实例。不要删除仍被进程使用的目录，也不要把真实 Hub/模型/A2A 凭据写入测试文档。当前无登录、单机文件存储及恢复边界见 [跨仓库启动说明](console-integration.md#数据与边界)。
