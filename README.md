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

Console 在当前浏览器记住最近选择的需求、Agent 或 Spec，以及 Spec 标签页、任务详情页签和移动端面板；刷新后根据最新数据恢复，已删除的对象回退到可用页面。未保存的输入草稿不在恢复范围内。

默认仅监听 `127.0.0.1:8920`。可在启动前用 `REIND_HTTP_ADDR=127.0.0.1:端口` 修改；端口 `0` 自动分配，`daemon start/status` 输出实际地址。只接受 loopback 和同源请求。

```sh
rein daemon start
rein daemon status
rein daemon stop
rein daemon restart
```

`run.sh` / `stop.sh` 等价于 daemon start / stop。start 提供并打印地址，不自动启动浏览器。队列任务默认要求 Agent 无窗口运行浏览器测试和截图，不连接用户正在使用的浏览器；只有用户明确要求时才打开窗口。这个约束写在任务指令中，不改变原生 Agent 的权限或工具配置。

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

可选原生参数包括 `--executable`、`--native-config`、`--model` 和 `--prepare`。独立对话默认在 `<REIND_HOME>/agents/<类型>/` 启动，可用 `--directory` 或 `--workspace` 设置覆盖值。项目内的任务与对话使用项目首选目录；从任务历史续聊沿用该次执行记录的目录。CLI 相对路径按调用位置解析为绝对路径。

本地 Agent 对象仍保存在 `<REIND_HOME>/agents/<名称>.json`。默认使用原生 CLI 配置。开启独立配置后，同类 Agent 的新会话共用 `agents/codex/config.toml` 或 `agents/pi/settings.json` 和 `agents/pi/models.json`。首次开启会导入模型和提供商相关配置，`--native-config` 可指定导入来源。已有共享文件和原生登录状态保存在各自目录，Codex 的独立目录可能需要单独登录。切换只影响新会话，已有会话继续使用创建时的配置目录。

系统配置的「Agent 配置」可按类型切换配置来源。开启独立配置后可查看和编辑共享文件。「Agents 编排」负责角色与调度。每个 Agent 的「模型与思考」可覆盖当前类型配置的默认值。

侧栏每个 Agent 的齿轮打开独立配置弹窗，沿用系统配置样式。可保存权限、模型 ID、思考强度、默认技能来源、附加技能目录和技能启停，也可修改本地运行参数；运行中的 Agent 拒绝修改。保存写入本机 Agent JSON，下次运行时读取，包括续聊。名称关联历史，不能通过编辑改名。

系统配置的「Agent 配置」可设置 Codex 的默认权限模式。请求审批（`workspace_write`，也接受 `ask_for_approval`）使用工作区写入沙箱，需要额外权限时由用户审批。帮我审批（`approve_for_me`）使用同样的沙箱和 `on-request` 策略，由 Codex 自动审查符合条件的请求。完全访问（`full_access`）使用 `danger-full-access` 和 `never`，也是 Rein 的初始默认值。已有的 `read_only` 配置继续使用只读沙箱，直到用户更改模式。Agent JSON 中省略 `permissions` 即继承类型默认值，显式填写则覆盖。有效权限在下一轮执行时应用。Pi 固定显示完全访问，按启动账户和运行环境的权限执行。A2A 权限由远端管理。模型和 `reasoning_effort` 留空时沿用 CLI 配置，具体组合由原生 CLI 校验。

技能默认使用 Rein 管理的 `<REIND_HOME>/skills`（通常为 `~/.reind/skills`），不自动加载原生用户或项目技能目录；Agent 设置的 SKILL 配置显示来源选项和只读的实际默认目录。`skill_source` 默认为 `rein`，保存时可省略；选择 `native` 可恢复原生用户／项目目录发现，兼容不支持指定目录的 CLI。`skill_directories` 只保存附加绝对目录，默认留空，运行时添加管理目录不会写回该字段。`disabled_skills` 为禁用技能的绝对 `SKILL.md` 路径，仅对当前 Agent 的执行生效，不修改共享技能文件或用户级 CLI 配置。默认模式下 Pi 只显式加载已启用的文件技能，Codex 通过额外目录发现和会话级技能配置筛选。Pi 筛选覆盖发现的文件技能，包和扩展技能需通过原生配置管理；A2A 的这些设置由远端维护。

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
  skills/rein-spec/       # Rein 管理的技能源文件，首次启动时初始化
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

`enabled` 保存是否允许接收任务（上线/下线），不代表进程正在运行或远端已通过连通性检查。配置按请求从磁盘重新读取，无需重启。文件名必须匹配 name；名字支持 1–64 个中英文、数字、`-` 和 `_`。重名 add 不覆盖已有文件。切换 Agent 类型、本地或远端执行方式，或更改 A2A 连接时，需要开始新对话。项目保存会检查当前版本，拒绝覆盖其他页面或手工编辑产生的变动。

项目创建与编辑沿用 Agent 设置的弹窗、侧栏分类、配置行和底部操作样式，分为「基本设置」和「工作目录」，显式保存到本机。项目可关联多个已存在的本机绝对路径工作目录，保留添加顺序；首个目录默认为首选，也可在编辑项目时切换首选。配置保存在项目 JSON 的 `directories` 和 `preferred_directory` 字段，旧项目无需迁移。项目列表只在页面加载、创建和编辑项目后读取，不参与 Agent 状态轮询。

Console 管理项目、需求、Spec 和 Todo。侧栏的 Spec 与需求节点通过同一实时连接显示运行状态：蓝色转圈表示执行中，对话问号表示等待用户回复或审批，Spec 另有异常、暂停、待开始和完成图标。需求仅汇总 Todo 的实际运行、交互与异常状态；已入队任务异常停止或当前轮验收失败时也显示警告，普通停止、暂停及空闲不显示状态图标；状态图标紧跟节点名称，与右侧功能按钮分开。Spec 汇总主 Agent、文档同步和关联任务；当前文档待确认或流程可提交验证／完成时，显示进入下一阶段的箭头，优先于自动执行的暂停标记。交互优先展示，悬停可查看同时存在的其他状态。需求页显示该需求的全部任务；左侧需求的编辑按钮旁可新建 Spec。每份 Spec 使用 Waypoints 节点图标和独立的主 Agent 会话，中间标题为“需求名称 - Spec 名称”，右侧显示需求、设计、任务、验证四个页签。Agent 对话沿用 Markdown、折叠执行过程、原生审批/输入、历史和停止执行，没有模拟消息回退。

rein-spec 在生成需求前先审视问题定义、跨领域搜索经典问题与成熟解法，再按依赖决策树分轮澄清；同轮问题给出推荐选项和自定义回答，用户确认共同理解后才起草 `requirements.md`，随后仍需审阅需求、设计与任务文档。Console 支持 Codex 多题选项及说明、Pi 选择请求和自定义输入，不默认选择推荐项；问题卡仍限制在当前聊天区一半高度，内容过长可在卡内滚动。

新建 Spec 填写名称和“你想做什么”，选择“构建新东西”或“修复 bug”，工作目录沿用项目设置。点击“开始对话”后打开 Spec 工作区，自动发送创建指令；启动失败保留 Spec 和错误，可在 Agent 上线后重试，重试不会重复创建首轮对话。修复类型要求复现、根因、保留正常行为和回归验证，旧 Spec 默认按构建新东西处理。

右侧文档随对话更新，阶段推进时自动切到对应页签。主 Agent 按 `rein-spec` Skill 理解用户的自然语言确认、拒绝和修改要求，统一维护 Spec 目录内的 `.spec-state.json`；右侧确认按钮也向同一会话发送消息。程序不匹配确认词，只在主 Agent 成功结束本轮后读取文件、校验文档和计划，再同步界面或入队。文件包含 `phase`（`requirements` / `design` / `tasks` / `building`）、`decisions`、`blocking` 和 `context.template`（`feature` / `bugfix`）。任务计划仍需用户同意后才开始构建；Coding / Review 的实际结果继续由执行记录与交接文件校验。旧 `spec-state.json` 在首次加载时保留并迁移，新文件已存在时不覆盖。未保存的右侧草稿需先保存再继续对话。

先在头像菜单 → 设置 → 执行环境中选择主 Agent、Coding Agent 和 Review Agent，并用 `rein agent up <name>` 将 Agent 上线。同一 Agent 可以兼任全部角色，忙碌时不会同时领取任务。执行环境用标签显示技能与角色，主界面侧栏只显示主 Agent、Coding、Review 三种角色标签。开启自动领取后，空闲 Agent 按角色领取待开始任务；关闭后可手动开始。需求对话支持“添加任务：任务内容”直接创建 Coding 任务，普通讨论中主 Agent 也会按提示通过本机 API 添加任务。直接任务不强制归属 Spec。

选择主 Agent 时，reind 按该 Agent 的默认来源及附加目录检查已启用的 `rein-spec`；Rein 管理目录中已启用时无需复制到原生目录。原生兼容模式缺少该技能时，Console 保留来源、安装目标和确认弹窗；Agent 设置另提供「原生目录备用安装」。只有点击“允许安装”才将 `~/.reind/skills/rein-spec/` 的完整内容复制到原生默认技能目录：Pi 使用 `~/.pi/agent/skills/`（跟随 `native_config` 或 `PI_CODING_AGENT_DIR`），Codex 使用 `~/.agents/skills/`。`REIND_HOME` 会改变技能源目录。首次启动从随程序分发的技能初始化源文件，保留已有源文件和原生技能，不自动覆盖更新。共用技能目录的 Agent 会共享安装结果，下次原生执行时发现技能；远程 A2A 需在远端安装。

技能标签来自所选来源及附加目录中的技能文件，表示已发现；是否启用以该 Agent 的技能开关为准，不代表原生 CLI 的完整技能清单，也不包含插件技能。检查使用 reind 的用户环境，不执行 `prepare`；若 `prepare` 改写 HOME 或技能目录，需自行核对原生实际加载位置。

### Spec 与任务运行时

Spec 工作流（`src/workflow/spec_runtime.rs`）负责 SDD 阶段及顺序提交；Todo 运行时（`task_runtime.rs`）只负责角色分配、执行、停止、结果和交接校验。二者共享 SQLite 的 `workflow_state`，任务只存一份，Spec 列表和需求 Todo 是不同范围的视图。项目和需求配置仍保存在 JSON 中，需求不再包含 `tasks` 字段；Todo 任务统一保存在 SQLite，项目配置接口拒绝写入旧任务字段。

1. 审阅并确认需求、设计后，点击“开始构建”：只把第一个 Coding 任务放入需求 Todo 的待开始。它完成后再提交下一项；暂不进行 DAG 编排。
2. 所有开发任务完成后，用户可“提交验证”。每条验收标准生成一项 Review 任务，也逐项进入待开始。
3. 验收未通过时，Review Agent 在结果中分析责任任务。关联成功则将原 Coding 任务退回待开始并附加返修 handoff；找不到同一 Spec 中的关联任务则创建新的修复任务。
4. 修复完成后自动开始下一轮验收，重新检查全部验收标准。全部通过后由用户“完成验证”。历史 Review 任务和每轮交接仍保留。

Todo 任务可从任务操作菜单删除，仅移除 SQLite 队列记录，保留 Spec 的 `tasks.md`、交接文件和执行历史。实际执行尚未结束（包括等待输入、审批或取消中）时须先停止并等待结束；异常退出等已结束执行不受“进行中”列限制。删除 Spec 关联任务会暂停其自动推进，防止立即重新入队；可从任务计划重新提交，或显式继续流程。

单个任务或整个 Spec 可停止。暂停流程会取消正在执行的关联任务；继续流程恢复正常排队。进程失败、缺失/非法结果、异常重启会将任务保留在待开始并暂停，须显式重试，不会自动反复执行。任务详情保留原浮动 Drawer、拖宽、双击逐级覆盖、右上角同逻辑切换、草稿保护和焦点返回；任务说明默认以 Markdown 阅读，提供紧凑的编辑／预览入口，编辑框不使用浮动标签；执行中及已完成任务的说明只读。队列任务的「Agent 会话」展示当前或最近一次任务执行所属的会话、原生审批／提问及文件变更，旧普通任务保留「操作记录」。Agent 正在执行时，Enter 将消息排队，本轮结束后在同一会话发送；原生 Pi/Codex 可用 Ctrl+Enter（macOS 用 ⌘+Enter）立即指导当前执行。指导内容与 Agent 接收回执保存在 `command_acks`。任务完成、停止或失败退回待开始后，可在原会话发起新一轮对话，不改变任务状态和结果。等待审批／回答时先回应交互；还没有会话的任务需先开始。聊天草稿在当前页面内按会话保留，关闭任务详情或切换会话后可继续编辑。每个会话可排队一条消息，发送前可撤回。刷新页面会清空草稿和未发送的排队消息，发送失败时会保留内容。

每份 Spec 的产物位于 `~/.reind/specs/YYYYMMDDHHmm-UUID/`。任务直接来自 `tasks.md` 的非空 Markdown 复选项，按文档顺序读取，忽略围栏代码块中的示例；验收直接来自 `requirements.md` 的 `## Acceptance Criteria` 章节。优先给任务标明 `T-01` 等稳定 ID，验收条目标明 `AC-01`；任务下用缩进的 `Acceptance: AC-01` 关联验收。省略 ID 时程序按顺序生成，后续重排应在执行前重新确认。规划数据不再维护独立 JSON 文件；SQLite 保存已确认文档的执行快照和实际状态，勾选不控制调度。

Spec 任务页默认展示任务进度，保留编辑和预览入口查看或修改 `tasks.md`。整份任务计划确认后，默认逐项提交到 Todo 待开始；用户也能从 Spec 的任务进度把任意尚未提交的任务加入 Todo，重复点击不会创建重复作业。提交不等于立即开始，实际执行仍按自动领取配置或 Todo 中的手动开始操作进行。

用户通过聊天或手动保存修改当前及更早的文档时，主 Agent 将规划游标回到该文档阶段，完成澄清后再邀请确认。编辑发生改动时显示“保存 / 取消”，取消不改文件、不触发 Agent。确认进入下一阶段时，已有文档可选择原样进入或让主 Agent 只修改紧邻的下一份文档；保存时不批量生成后续产物。已提交的开发与验证继续使用原执行快照，不因文档修订重建队列或重跑作业。标签前的绿色小点表示已生成，绿色勾表示当前文档版本已确认；修改后需重新确认。任务复选框和验证记录的进度同步不取消任务文档确认。

任务 runtime 将开始、等待交互、完成和失败通知持久化到需求群聊，显示实际 Coding / Review Agent 身份；交互请求 @用户并提供任务入口。Spec 完成回报会排队唤起主 Agent，只更新 `tasks.md` 的复选框和末尾 Verification Results。主 Agent 根据 SQLite 执行快照同步文档，不执行其他任务；运行时验证文档确已更新且未改变任务定义，失败可重试。主 Agent 写文档时的原生审批同样在群聊 @用户，并提供直接回复控件，不会自动批准。通知和更新请求重启后保留，已有作业不会因重试重复派发。

执行器复用现有原生/A2A 通道；自动编排要求执行端能访问这些本机产物路径，未返回有效文件的执行不会误报完成。技能安装需在 Console 明确确认，不自动批准 CLI 的权限请求。

Pi 和 Codex 入口分别在 `src/agents/pi.rs`、`src/agents/codex.rs`，原生协议复用 `a2alinker::native`。沿用原生认证和扩展，权限及技能覆盖由单 Agent 配置决定；运行中收到的交互仍需用户明确回复。同一目录最多一个原生执行，全局最多四个执行，同一 Agent 串行。

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
