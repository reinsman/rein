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

Console 直接管理项目、需求及任务状态；只有独立 Agent 对话，没有工作空间或项目群聊。任务看板是本地规划，不会自动启动 Agent。Agent 对话支持 Markdown、工具详情、公开思考摘要、审批/输入、会话切换、历史分页、实时事件和停止执行。没有模拟消息或演示数据回退。

需求页沿用 Todo 的“待开始／进行中／已完成”三列。新建需求时自动创建 Spec、Design、Tasks、验证四张阶段任务卡；旧需求可点击“初始化 SDD”补齐，已有普通任务保留。阶段按前置依赖解锁，拖动或菜单操作也会检查顺序和完成条件。

点开卡片使用可拖宽、展开／恢复的浮动任务抽屉：Spec 编辑需求文档和验收标准，Design 编辑技术设计，Tasks 管理开发子任务，验证逐项填写结果及证据。文档支持 Markdown 预览，草稿、负责人、子任务和验收记录保存在项目 JSON 中，关闭未保存草稿前会提示。Spec、Design 需要确认文档；Tasks 需要完成全部子任务；验收需要每项通过且有证据。重新打开上游任务会将后续阶段移回待开始，并重置验收结果，保留证据供复核。

本版 SDD 页面由用户手动推进和确认，分配负责人不会自动调用 Agent 或运行测试；工作记录只展示实际保存、开始、确认和重新打开操作，最多保留最近 200 条。

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
