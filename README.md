# rein · local

由 `reind` 统一提供 Console、Agent 管理和对话执行。此分支专注单机，不需要 reinhub、注册或登录。

```text
rein CLI ── Unix socket ── reind ── Native Backend ── Pi / Codex
                            ├───── A2A Backend ──── 远程 Agent
浏览器 ───── HTTP / SSE ─────┤
                            └───── 内嵌 Console + SQLite 对话历史
```

## 构建与启动

需要 Rust 1.89+、Node.js 22.12+ 和 npm；开发时并排检出 `../proto`、`../a2alinker`。原生 Agent 的二进制及模型凭据由用户自行安装配置。

```sh
./build.sh
./rein.sh daemon start
# Console: http://127.0.0.1:8920
```

打开输出地址即可使用 Console。Rust 构建会自动安装 `console/` 的 npm 依赖、构建前端并将资源编入二进制，运行时无需 Node 或单独的静态服务器。`rein` 与 `reind` 需放在同一目录。也可 `cargo install --path . --locked`。

默认仅监听 `127.0.0.1:8920`。可在启动前用 `REIND_HTTP_ADDR=127.0.0.1:端口` 修改；端口 `0` 自动分配，`daemon start/status` 输出实际地址。只接受 loopback 和同源请求。

```sh
rein daemon start
rein daemon status
rein daemon stop
rein daemon restart
```

`run.sh` / `stop.sh` 等价于 daemon start / stop。start 提供并打印地址，不自动启动浏览器。

## Agent

必须同时指定类型和名字。类型决定适配器和 Console 图标，名字作为本机标识。

```sh
rein agent add codex coder --directory /absolute/path/to/project
rein agent add pi helper --directory /absolute/path/to/project
rein agent up coder
rein agent up helper
rein agent ls
rein agent inspect coder
rein agent down coder
rein agent up coder
rein agent rm coder

# 远程 Agent：保留 codex 或 pi 类型，使用 A2A 1.0 JSON-RPC
rein agent add codex remote-coder --a2a http://127.0.0.1:10100
rein agent up remote-coder
# 同时支持用户习惯的单横线拼写：-a2a URL
rein agent add pi remote-helper -a2a https://agent.example/rpc --token-env REMOTE_AGENT_TOKEN
rein agent up remote-helper
```

add 只保存配置，初始下线；执行 `rein agent up <名称>` 上线后才接受新消息。上线只表示允许接收任务，本地 Agent 进程在发送消息时按需启动，每轮结束后退出，不保持空闲进程；远程 A2A 在执行时连接。`down` 停止接受新消息，保留配置和历史。下线和删除会拒绝正在执行的 Agent，请先在 Console 停止或完成执行。rm 只删除配置，保留历史；同名重新添加会再次关联这些历史。

可选原生参数：`--executable`、`--native-config`（原生配置目录或文件）、`--model`、`--prepare`。`--directory` 默认当前目录，兼容 `--workspace` 拼写。路径由 CLI 相对调用位置解析为绝对路径。

```sh
rein agent add pi helper --directory "$PWD" \
  --prepare 'source "$HOME/.nvm/nvm.sh" --no-use && nvm use --silent 24'
```

prepare 在启动前通过 Bash 设置子进程环境，失败后不启动 Agent。A2A 不接受原生参数；远端环境由远端服务维护。token-env 只保存环境变量名，变量必须存在于 reind 的启动环境中。

如果 Codex 需要代理，可在 Rein 仓库目录执行以下命令。示例假设代理的 HTTP / Mixed 端口为 `7890`，请替换为实际端口：

```sh
./rein.sh agent add codex Chris \
  --directory "$PWD" \
  --prepare 'export HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897'

./rein.sh agent up Chris
```

`coder` 是 Agent 名称，可自行修改；`--directory` 指定 Codex 的工作目录。代理变量会在每次启动 Codex 前设置，仅影响这个 Agent 的子进程环境，无需重启 daemon。

不再提供 `register`、`native`、`login`、`run`、`runs`、`sessions`、`a2a`、顶层 `up/down/ls` 和 `agents` 命令。执行、历史、审批与停止统一从 Console 操作。

## 文件与历史

默认使用 `~/.reind/`，可通过 `REIND_HOME` 修改，兼容已有 `REIN_HOME` 环境变量。所有命令需使用同一个状态目录。

```text
~/.reind/
  agents/coder.json       # 小型 Agent 配置，可手工编辑
  projects/<uuid>.json    # 项目、需求和任务
  reind.sqlite           # 对话、执行事件、会话引用和控制回执
  reind.sock             # CLI IPC
  daemon.lock
  daemon.log
```

Agent 配置示例：

```json
{
  "name": "coder",
  "provider": "codex",
  "enabled": false,
  "directory": "/Users/you/project",
  "executable": null,
  "native_config": null,
  "model": null,
  "prepare": null,
  "a2a": null
}
```

`enabled` 保存是否允许接收任务（上线/下线），不代表进程正在运行或远端已通过连通性检查。配置按请求从磁盘重新读取，无需重启。文件名必须匹配 name；名字支持 1–64 个中英文、数字、`-` 和 `_`。重名 add 不覆盖已有文件。修改执行配置后应开始新对话，避免错误续接原生会话。项目保存会检查当前版本，拒绝覆盖其他页面或手工编辑产生的变动。

项目可关联多个已存在的本机绝对路径工作目录，保留添加顺序；首个目录默认为首选，也可在编辑项目时切换首选。配置保存在项目 JSON 的 `directories` 和 `preferred_directory` 字段，旧项目无需迁移。项目列表只在页面加载、创建和编辑项目后读取，不参与 Agent 状态轮询。

Console 管理项目、需求、Spec 和 Todo。需求页显示该需求的全部任务；左侧需求的编辑按钮旁可新建 Spec。每份 Spec 使用 Waypoints 节点图标和独立的主 Agent 会话，中间标题为“需求名称 - Spec 名称”，右侧显示需求、设计、任务、验证四个页签。Agent 对话沿用 Markdown、折叠执行过程、原生审批/输入、历史和停止执行，没有模拟消息回退。

先在头像菜单 → 设置 → 执行环境中选择主 Agent、Coding Agent 和 Review Agent，并用 `rein agent up <name>` 将 Agent 上线。Coding 与 Review 名单互斥；主 Agent 可以兼任，但忙碌时不会同时领取任务。开启自动领取后，空闲 Agent 按角色领取待开始任务；关闭后可手动开始。需求对话支持“添加任务：任务内容”直接创建 Coding 任务，普通讨论中主 Agent 也会按提示通过本机 API 添加任务。直接任务不强制归属 Spec。

### Spec 与任务运行时

Spec 工作流（`src/workflow/spec_runtime.rs`）负责 SDD 阶段及顺序提交；Todo 运行时（`task_runtime.rs`）只负责角色分配、执行、停止、结果和交接校验。二者共享 SQLite 的 `workflow_state`，任务只存一份，Spec 列表和需求 Todo 是不同范围的视图。项目配置仍保存在 JSON 中，旧普通任务和旧阶段卡不会被删除或自动执行。

1. 审阅并确认需求、设计后，点击“开始构建”：只把第一个 Coding 任务放入需求 Todo 的待开始。它完成后再提交下一项；暂不进行 DAG 编排。
2. 所有开发任务完成后，用户可“提交验证”。每条验收标准生成一项 Review 任务，也逐项进入待开始。
3. 验收未通过时，Review Agent 在结果中分析责任任务。关联成功则将原 Coding 任务退回待开始并附加返修 handoff；找不到同一 Spec 中的关联任务则创建新的修复任务。
4. 修复完成后自动开始下一轮验收，重新检查全部验收标准。全部通过后由用户“完成验证”。历史 Review 任务和每轮交接仍保留。

单个任务或整个 Spec 可停止。暂停流程会取消正在执行的关联任务；继续流程恢复正常排队。进程失败、缺失/非法结果、异常重启会将任务保留在待开始并暂停，须显式重试，不会自动反复执行。任务详情保留原浮动 Drawer、拖宽、双击逐级覆盖、右上角同逻辑切换、草稿保护和焦点返回；工作记录接入真实执行事件及原生审批。

每份 Spec 的产物位于 `~/.reind/specs/YYYYMMDDHHmm-UUID/`（本机时间；设置 `REIND_HOME` 时跟随该目录）。`requirements.md`、`design.md`、`tasks.md` 与 handoff 文件在同一目录。当前假设已安装 `rein-spec` skill，主 Agent 提示词会说明完整写作和审批规则，并要求同步生成供程序读取的 `plan.json`：

```json
{
  "criteria": [{ "id": "AC-01", "text": "可验证的预期行为" }],
  "tasks": [{ "id": "T-01", "title": "开发任务", "description": "实现范围", "acceptance_ids": ["AC-01"] }]
}
```

ID 必须稳定、唯一，任务数组顺序即执行顺序。程序在开始构建时固定清单和验收标准，已确认的条目不能在后续阶段悄悄替换。文档可手动编辑，保存会检查是否被其他页面或 Agent 改动；离开未保存草稿前会提示。

每次 Coding/Review 执行使用独立会话，提示中给出精确产物路径：`task-UUID-aN-coding-handoff.md` 或 `task-UUID-aN-review-handoff.md`，建议约 100–300 字，记录修改、检查、证据和遗留事项；旁边的同名前缀 `result.json` 必须包含 `outcome`（`passed` / `failed`）、`summary`、`evidence`，Review 可另给 `responsible_task_id`（Coding 任务 UUID 或该 Spec 的计划 ID，无法关联则为 `null`）。CLI 正常退出且这些产物有效才算任务完成。`task-index.json` 提供任务 UUID 与交接文件索引，返修说明另存为 `task-UUID-repair-rN-REVIEW_UUID.md`；任务卡下可查看 Coding、Review 和返修交接。直接任务产物放在 `~/.reind/tasks/UUID/`。

执行器复用现有原生/A2A 通道；自动编排要求执行端能访问这些本机产物路径，未返回有效文件的执行不会误报完成。不会代装 skill 或自动批准 CLI 的权限请求。

Pi 和 Codex 入口分别在 `src/agents/pi.rs`、`src/agents/codex.rs`，原生协议复用 `a2alinker::native`。保持原生认证、技能、扩展和审批策略，不自动批准交互。同一目录最多一个原生执行，全局最多四个执行，同一 Agent 串行。

历史与会话引用重启后保留；正常结束后通过 Codex thread ID / Pi session 文件或 A2A context 恢复。stop / SIGINT / SIGTERM 会先取消并清理执行。异常退出不会自动重跑任务：未确认结束的历史标记失败并禁止旧会话续接，远端或脱离进程组的工具可能仍需手动检查。SQLite 历史尚无自动清理策略。

本分支不自动迁移旧 `~/.rein` 的 Hub 注册或数据库。旧目录和原 `/Users/xhb/github/rein-console` 均保持原样。

## 开发与验证

后续前端只修改本仓库的 `console/`：

```sh
cd console
npm ci
npm run dev
# Vite 将 /api 代理到 http://127.0.0.1:8920
# 自定义后端地址：REIND_URL=http://127.0.0.1:其他端口 npm run dev
```

```sh
cargo test --locked
cargo clippy --all-targets --locked -- -D warnings
npm run lint --prefix console
npm run typecheck --prefix console
# 先构建当前二进制；测试会独立启动临时 reind，不使用个人数据
npm run test:e2e --prefix console
```

集成测试使用确定性的 Pi/Codex 子进程和 A2A HTTP 服务，验证协议、续聊、审批、取消、持久化、配置编辑和来源校验，不调用付费模型。
