---
name: Rein
description: Original compact white Console for requirement conversations and Agent tasks.
colors:
  primary: "#0866ff"
  success: "#08a56d"
  warning: "#f59b00"
  error: "#db2e32"
  text: "#202632"
  text-secondary: "#7a8190"
  surface: "#fff"
  sidebar: "#f7f8fa"
  muted: "#f3f4f6"
  task-group: "#f6f7f9"
  selected: "#eaf2ff"
  border: "#e5e8ef"
  terminal-bg: "#0d1117"
  terminal-text: "#cdd5df"
  terminal-secondary: "#a0a9b6"
  terminal-success: "#3fb950"
  terminal-cyan: "#81d4da"
  terminal-border: "#30363d"
typography:
  title:
    fontFamily: "Inter, 'Noto Sans SC', sans-serif"
    fontSize: "15px"
    fontWeight: 500
    lineHeight: "22px"
  body:
    fontFamily: "Inter, 'Noto Sans SC', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: "21px"
  label:
    fontFamily: "Inter, 'Noto Sans SC', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
  caption:
    fontFamily: "Inter, 'Noto Sans SC', sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: "16px"
  task-title:
    fontFamily: "Inter, 'Noto Sans SC', sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "20px"
  terminal:
    fontFamily: "'JetBrains Mono', 'Noto Sans SC', monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "21px"
  login-title:
    fontFamily: "Inter, 'Noto Sans SC', sans-serif"
    fontSize: "20px"
    fontWeight: 500
    lineHeight: "30px"
rounded:
  control: "6px"
  container: "8px"
  dialog: "12px"
spacing:
  xs: "4px"
  compact: "6px"
  sm: "8px"
  control: "10px"
  md: "12px"
  lg: "16px"
  panel: "20px"
  dialog: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "3px 10px"
  button-outlined:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "3px 10px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
  navigation-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "5px 8px"
  task-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.container}"
    padding: "10px"
  message-bubble:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.container}"
    padding: "9px 12px"
  message-bubble-own:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.container}"
    padding: "9px 12px"
  terminal:
    backgroundColor: "{colors.terminal-bg}"
    textColor: "{colors.terminal-text}"
    typography: "{typography.terminal}"
    rounded: "{rounded.control}"
    padding: "16px"
  settings-switch:
    backgroundColor: "transparent"
    rounded: "{rounded.container}"
    size: "32px"
---

# Design System: Rein

需求是总任务范围，Spec 是需求下的独立工作流子节点，用 Waypoints 图标表示连接的步骤。选中需求保留讨论和三列 Todo，汇总直接任务和所有 Spec 的构建／验证任务；选中 Spec 切为主 Agent 独立对话与 Spec 四页签。右侧任务进度和需求 Todo 共用任务状态。Coding／Review 使用代码／盾牌图标区别，Spec 来源任务采用轻蓝底和 SDD 标识，交接文件以子条目展示。构建和验证均逐项提交，由服务端按角色分配空闲 Agent，验收失败通过返修 handoff 回到 Coding，修复后重验。任务详情沿用原浮动 Drawer、拖宽、逐级覆盖／恢复、外部关闭、草稿保护和焦点返回，队列任务的 Agent 会话展示真实执行及审批，旧普通任务使用操作记录。旧普通任务和旧阶段卡保留，不生成模拟成果。

## Overview

**Creative North Star: "Compact white workspace"**

Rein is a compact application for operating a workspace through scoped group conversations and Agent tasks. White work areas, a pale sidebar, white task columns and small controls keep conversation, task status and execution output visible together. Typography and spacing serve scanning and frequent interaction.

The visual authority is [Figma pzrgKXgJAyugcvBNC16Ick](https://www.figma.com/design/pzrgKXgJAyugcvBNC16Ick): main workspace `2:34`, task detail `2:35`, login `12:1111`, settings `12:1112`–`12:1116`, account menu `24:3887` and logout dialog `24:4369`. The implemented source of tokens is `src/theme.ts`; `src/App.css` and the components define layout and component details. Preserve these references when extending the application.

**Key Characteristics:**

- Compact white application surfaces with thin dividers.
- Small Inter and Noto Sans SC typography; JetBrains Mono for terminal output.
- Blue actions and selection, with explicit status text alongside status icons.
- Resizable conversation and task panes, with responsive navigation and task groups.
- Native Figma SVG assets at their intended intrinsic sizes.

## Colors

The palette is predominantly white and cool gray. Blue identifies actions, active execution and selection; status colors carry specific operational meaning. Frontmatter values are normative.

### Primary

- **Action blue** (`primary`): contained actions, focus outlines, active execution, the resize divider on interaction and selected card borders.
- **Selected pale blue** (`selected`): selected navigation, the user's message bubbles and active toolbar actions.

### Secondary

- **Completion green** (`success`): completed tasks, online presence and connected states.
- **Waiting amber** (`warning`): tasks and messages waiting for a reply.
- **Destructive red** (`error`): the logout confirmation action and error feedback.

### Neutral

- **Primary ink** (`text`) and **secondary gray** (`text-secondary`): main content and supporting labels, timestamps, descriptions and metadata.
- **White surface** (`surface`): conversation, task cards, settings and dialogs.
- **Sidebar gray** (`sidebar`): persistent navigation and the compact toolbar.
- **Muted gray** (`muted`): agent message bubbles, search and the selected settings category.
- **Task group gray** (`task-group`): the background behind task cards.
- **Divider gray** (`border`): pane boundaries, outlined controls, card borders and row separators.
- **Terminal dark** (`terminal-bg`), **terminal text** (`terminal-text`), **terminal secondary** (`terminal-secondary`) and **terminal divider** (`terminal-border`): the execution console only. **Terminal green** (`terminal-success`) and **terminal cyan** (`terminal-cyan`) distinguish output and command controls inside that surface.

**The Status Meaning Rule.** Keep waiting, execution and completion colors tied to their existing meanings. Accompany status colors with labels or icons.

## Typography

**Body and interface font:** Inter, with Noto Sans SC and sans-serif fallbacks. **Terminal font:** JetBrains Mono, with Noto Sans SC and monospace fallbacks. Chinese and Latin text share the compact hierarchy; interface labels retain their natural case.

### Hierarchy

- **Title**: panel, detail and settings headings. The login title is the larger, centered exception.
- **Body**: message content, settings labels and normal application text.
- **Label**: buttons, inputs, tabs, select values, task assignees and supporting descriptions.
- **Caption**: timestamps, counts, task IDs and saving status.
- **Task title**: medium-weight task names and small section headings.
- **Terminal**: execution output and command input, with the default size set by the terminal token.

The default body is (13px), labels (12px), captions (11px), titles (15px) and terminal output (12px). The existing preferences offer (14px) for message bubbles, assignment rows and navigation, and (13px) terminal output. They do not globally enlarge every interface element. Preserve wrapping for message and task text; truncate compact pane headings with an ellipsis.

## Layout

The application fills the dynamic viewport height. Each primary pane owns its scroll area; the shell does not scroll. The desktop sidebar is (296px) wide. At the reference width of (1600px), the initial composition is approximately (624px) conversation and (680px) tasks beside that sidebar, separated by a (1px) divider. The initial ratio is `624 / 1304`; user resizing persists locally.

Both split panes have a minimum width of (360px). Dragging the divider or using its focused left/right arrow controls changes the ratio; keyboard steps are (2 percentage points). The divider has an enlarged pointer target around its thin visible line. Hiding the sidebar gives the panes the reclaimed width.

Panel headers are (65px) high on desktop. Conversation padding is generally (20px); the task board has (16px) padding and (12px) gaps. Controls use small gaps, usually (6px) or (8px). Keep compact density instead of substituting large dashboard spacing.

Task groups form three columns when the task pane is wide. At a task-container width of (560px) or less, groups stack with intrinsic row heights and align to the top; cards form two columns within each group. Groups must grow with their cards, including wrapped titles. At (390px) or less, cards become a single column. These thresholds respond to the task pane, independently of viewport width.

At viewport widths of (1199px) or less, the sidebar is a temporary drawer, opened from the compact toolbar. At (899px) or less, a chat/tasks toggle shows one primary pane at a time and the divider is hidden. Headers become (60px) high, settings navigation becomes a horizontal strip, and content padding contracts. At (480px) or less, settings rows stack their labels and controls and select fields fill the available width.

Task detail overlays from the right. Before manual resizing, its left edge aligns with the rendered right edge of the Todo title; on mobile its initial width is the viewport width. Pointer and keyboard resizing save its fraction of the viewport width in localStorage, shared by all tasks and retained on reopening or refreshing. Window resizing scales this saved fraction, with the rendered width constrained to available workspace space and a (260px) readable floor; these constraints never overwrite the saved ratio. Pointer resizing normally stops at (360px), or at the narrower initial/current width when necessary. Expanding uses the available main-workspace width, excluding the visible desktop sidebar; restoring returns to the saved ratio. Neither changes the saved conversation/task split. At detail widths up to (480px), tabs and session controls wrap onto separate rows. Settings use a (1040px × 720px) dialog constrained by (16px) viewport margins. Login uses a centered (360px) form bounded by (20px) side margins.

## Elevation & Depth

Most surfaces are flat. Thin borders and pale backgrounds separate navigation, groups, cards and conversation. Selected cards add a blue border and a subtle (1px) halo. Elevation is structural for overlays and menus, rather than decorative card lift.

### Shadow Vocabulary

- **Right detail and dialogs** (`-6px 0 18px #1726401f`): distinguishes the task overlay or dialog from the application beneath.
- **Account menu** (`0 6px 18px #1726401f`): a small elevated menu with a thin border.
- **Selected task** (`0 0 0 1px #0866ff33`): reinforces selection without moving the card.

Modal backdrops use the theme's translucent ink (`#20263229`). Invisible dismiss backdrops, including the account menu, remain transparent so opening a menu does not dim the workspace. Task detail is a persistent right overlay with an interactive paper surface.

## Shapes

Controls, inputs, navigation rows and the terminal use gently rounded corners (`control`). Task cards, task groups, message bubbles and the composer use the larger `container` radius. Dialogs use `dialog`. Avatar circles and tiny status dots are the recurring circular forms. Borders are generally (1px); avoid turning these compact rectangles into pills.

Icons are downloaded native Figma SVG files in `public/icons`. Keep the existing source paths and intrinsic asset geometry. The logout icon is composed from `account-MaterialLogout.svg` with the nested `account-Group5.svg` glyph; preserve both layers. Settings switches also use the native on/off SVGs rather than redrawing their appearance.

## Components

### Buttons

Small, restrained actions use the shared control radius. Default buttons have a minimum height of (28px), label typography and (3px 10px) padding; icons and text have a (6px) gap. Contained buttons use action blue and white, outlined buttons use the divider border and primary ink, and text actions remain visually light. Logout confirmation uses the destructive color. Icon buttons have a (26px) square target with (5px) padding. Hover states follow MUI and the explicit source overrides; keyboard focus remains visible with a (2px) blue outline and (2px) offset.

### Inputs / Fields

Outlined fields use the divider stroke, label typography, the control radius and (7px 10px) text padding. The shared minimum height is (32px); login and standalone forms use (36px). The search field has a muted background. Focus and validation follow the MUI outlined-input states. The conversation composer is a separate multiline container with actions along its bottom edge and a compact blue send button.

### Navigation

Sidebar rows have a minimum height of (32px), (5px 8px) padding and (8px) icon gaps. Selection uses pale blue with primary ink. Project rows toggle their tree, with project chat first and leaf requirements below. Project editing appears on hover or keyboard focus. Show five projects initially, then three more per click. Collapsed navigation leaves a (56px) rail with restore and workspace/project/requirement shortcuts; the avatar stays at the bottom. Agent roster rows open direct conversations and replace Todo with Memory. Do not add Agent management or task-status children to this navigation. Settings categories use taller (36px) rows and muted gray selection. Account actions appear in a (264px) menu with (6px) paper padding; its dismiss backdrop stays transparent.

Requirements expose the same hover/focus edit affordance as projects; creation remains on the requirements heading. Projects use Material folder outlines; requirements use target flags. The project section uses the remaining sidebar height, with an independently scrollable list beneath its heading. The Agent roster stays above the pinned account, leaving room for three to five Agents; larger rosters can scroll in their own region. Search, workspace chat, Agent roster and the pinned account do not share that scroll. Collapsing navigation preserves the chat track width and gives the released (240px) to Todo or Memory. Use Claude, Codex and pi provider SVGs consistently for Alex, Sam and Robin. Each Agent row has a monochrome settings gear revealed on hover or focus, while touch inputs retain visible access. The Agents heading has a create action. Chat and Todo toolbar gears have explicit pending-function feedback.

### Cards / Containers

Task cards are white, outlined and rounded with (10px) padding and a minimum height of (132px). IDs and action menus occupy a small metadata row above the task title, assignee and execution state. Hover changes the border to `#a9b8d2`; selection uses the primary border and selection halo. Group surfaces encode pending (`#f5f2fa`), running (`#eff5ff`) and completed (`#edf7f1`) with restrained tints and existing text/dot labels. Waiting tasks remain in running and use an amber surface (`#fff9eb`), border (`#b88627`), readable text (`#8a5600`) and explicit reply badge (`#ffe5ae`). Selected waiting cards retain a separate blue outline. Cards have (10px) gaps. At narrow task-container widths, group heights follow content rather than distributing a fixed viewport height.

### Conversation

Messages pair avatars with author and time metadata. Agent bubbles use muted gray; the user's bubbles use selected pale blue and align to the right. Bubbles use body typography, the container radius and (9px 12px) padding. Long bubbles and inline task assignments grow with the conversation pane; short user messages fit their content. Long text wraps without widening the pane. Inline task assignments form bordered rows (48px) high, with task actions opening the same detail view as task cards.

The composer has no scope chip. Agent conversations use the same composer and show an illustrative, editable-vector Memory graph in the adjacent pane. Keep the planning note visible; Memory has no implemented storage or execution behavior. Requirement dialogs retain a compact (440px × 380px) form with external labels, name and description fields, and cancel/save actions. Project creation and editing reuse the (1040px × 720px) settings shell, header, rows and footer, with “基本设置” and “工作目录” navigation. Preserve explicit local saving, ordered directory add/remove controls and the preferred-directory radio selection. Retain Material UI and the existing ChatGPT UI Kit reference patterns.

Agent settings open from each sidebar gear and reuse the compact (1040px × 720px) system settings dialog and row structure, with basic, execution permissions, models/thinking, SKILL, local and A2A categories. Full access is the default; Codex also offers workspace-write and read-only sandboxes with on-request approval, while Pi supports only full access because it has no native sandbox. Model IDs use a text field and thinking effort uses a provider-specific select; blank values inherit CLI configuration. The SKILL category defaults to Rein’s managed `<REIND_HOME>/skills`, provides a source selector and a read-only actual default path, and keeps additional directories empty unless explicitly entered. Scan the selected source plus saved additional directories, with per-Agent skill toggles; managed mode excludes automatic native user/project discovery, while the native compatibility source restores it. Keep “原生目录备用安装” separate, retaining its consent and no-overwrite explanation; an enabled managed rein-spec needs no native copy. Skill selection applies to the current Agent’s execution without rewriting user CLI configuration or deleting shared files. Creation and edits remain drafts until explicit save to local Agent JSON. Editing preserves identity/name, environment, preparation and availability; running Agents cannot be edited. A2A execution settings are managed remotely. Save errors keep the dialog open, and closing a dirty form exposes a discard action. The footer explains that saved changes require a new conversation. Long names ellipsize without crowding the close control, and the selected category exposes `aria-current`. On narrow screens the category bar scrolls horizontally and reveals the selected category; the form scrolls vertically and rows stack at the existing breakpoint.

System Agent settings put the saved type defaults above a collapsible configuration editor. Individual model and thinking rows show the type values next to each override control. The permissions page shows which choices the provider supports, and Codex access levels apply per Agent.

Nest the read-only default path under the skill source selector. Nest discovered entries and their switches under the discovery heading and refresh action. Keep additional directories and native fallback installation as separate rows.

Header avatars show Agent names on hover and insert @mentions at the composer caret on click. Message author buttons share this behavior. Preserve the draft and focus the composer after insertion. Waiting messages share the task attention palette and an explicit reply action. Amber text contrasts at least 5:1 against its badge and surface, and the border at least 3:1 against its surface. Color is reinforced by words and the waiting icon.

### Terminal and task detail

The task detail keeps a compact header, participant/status row, description, tabs and footer around its scrollable content. CLI output uses the terminal palette, mono typography and (16px) padding. Command input is separated by a terminal divider. Running indicators rotate once per second; reduced-motion preferences stop that rotation and reduce animation and transition durations. Task, CLI and result tabs share the compact label hierarchy. Tasks is the default: a compact progress summary and collapsible Requirements, Design, Planning, Execution and Verification sections show step owners and completion. Dashed arrows in Todo connect only explicit task dependencies, rerouting through card gutters when cards move or columns stack. Filtering hides links whose endpoints are absent.

Task completion messages with a Handoff show a short summary and the same quick preview as the task card. The preview title includes the task name, and the complete report remains available inside the chat preview.

Task descriptions open as rendered Markdown, with a compact explicit edit/preview action and an accessible multiline editor without a floating label; empty descriptions start in edit mode. Running queue tasks and completed tasks keep descriptions read-only, with running tasks directing guidance to “Agent 会话”. Queue tasks use that tab for the current session or the session of the most recent task run, with history, native approvals/questions and file diffs; legacy tasks retain “操作记录”. In all Agent chat composers, Enter queues one follow-up for the same conversation after the current run ends. Ctrl+Enter or ⌘+Enter steers an active native Pi/Codex run. Guidance and Agent receipts persist in the run’s `command_acks`. The queue stays in page memory across navigation and supports withdrawal before submission. Once the task is completed or stopped, sending a message starts another turn in the same session without changing task status or result. “停止回复” cancels that turn alone. Keep chat drafts in page memory by task or conversation. Reopening a task or switching conversations restores the draft, a page reload clears it, and a send failure keeps it available for retry.

Agent chat, task run history and the task's “产物” tab share a file-change section. Use matching Lucide outlines for the handoff and artifact controls. Artifact rows use file-type glyphs keyed by extension, with a generic file glyph as the fallback. Show the first five collapsed file rows and a single control to reveal the rest. Use paths relative to the run's working directory for files inside it, and align green addition and red deletion counts at the end of each row. Within an expanded file, show successive edits in execution order with old/new line numbers beside the scrollable diff. Show only successful, completed tool reports: Codex file changes, Pi edit diffs and Pi write content; indicate when no original content was recorded and line totals are unavailable. These reports do not cover changes made outside the reported tools. The “Handoff” tab expands the selected handoff Markdown below its row; quick previews outside task detail use the dialog reader.

### Settings switches and dialogs

Switch artwork is (28px × 16px), placed within a (32px) square interactive target. Keep labels and descriptions aligned to the setting row, with controls on the right until the narrow stacked layout applies. The logout dialog is (440px × 220px), constrained by the viewport, with a quiet cancel action and a red confirmation action. Native modal and menu keyboard behavior remains part of the component contract.

## Do's and Don'ts

### Do:

- **Do** use the pinned Figma nodes and implemented theme as visual authority for new screens.
- **Do** preserve the compact type hierarchy, white work areas and gray navigation and task-group surfaces.
- **Do** preserve native Figma SVG geometry and existing icon source paths, including the nested logout glyph.
- **Do** keep both desktop panes resizable with their minimum widths and persist the user's ratio.
- **Do** let stacked task groups grow to their content and switch card columns using task-container width.
- **Do** retain visible keyboard focus, labeled controls, status text and reduced-motion behavior.

### Don't:

- **Don't** replace the pinned visual system with a new metaphor, decorative palette or oversized typography.
- **Don't** dim the workspace behind the account menu's invisible dismiss backdrop.
- **Don't** force equal viewport-distributed heights onto the stacked task groups.
- **Don't** stretch native SVG icons or replace them with a different icon family.
- **Don't** turn task detail into a change to the stored conversation/task split.

Todo columns now share the white canvas, with 1px neutral separators. Cards use an almost-white surface; selection and waiting retain semantic accents. Non-active tasks can be dragged within or between columns, with a blue insertion indicator. Executing and waiting Agent sessions lock movement in both the UI and service. Outside pointer actions retract the detail drawer from the chat edge to Todo, then the saved custom width, then close it; identical widths are skipped. Portaled dialogs, menus and the sidebar toggle are exempt. Escape and the close button close directly. Unsaved task description edits prompt for confirmation. Completed Spec steps retain normal text and a green completion icon. The result tab uses an execution summary and four independently collapsible artifact sections.
