import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  Menu,
  MenuItem,
  Snackbar,
  TextField,
  useMediaQuery,
} from '@mui/material'
import type { Agent, AppData, ChatScope, Project, Requirement, TaskStatus } from './types'
import { defaultScope, reinService } from './services/reinService'
import { preferencesService } from './services/preferences'
import { Sidebar, SidebarRail } from './components/Sidebar'
import { EntityDialog } from './components/EntityDialog'
import type { EntityEditor } from './components/EntityDialog'
import { MemoryPanel } from './components/MemoryPanel'
import { NodeStatusProvider } from './components/NodeStatus'
import { Chat } from './components/Chat'
import { TaskPanel } from './components/TaskPanel'
import { SpecPanel } from './components/SpecPanel'
import { AgentChat } from './components/AgentChat'
import { TaskDetails } from './components/TaskDetails'
import { Settings } from './components/Settings'
import { AgentSettings } from './components/AgentSettings'
import { Login } from './components/Login'
import { Action, AgentAvatar, Icon } from './components/shared'
import { statusLabels } from './constants'
import type { QueueRole } from './services/workflow'
import { statusColors } from './theme'
import './App.css'

const minimumPaneWidth = 360

export default function App() {
  const [initialNavigation] = useState(preferencesService.navigation)
  const [navigationReady, setNavigationReady] = useState(!initialNavigation)
  const pendingNavigation = useRef(initialNavigation)
  const projectsReady = useRef(false)
  const [data, setData] = useState<AppData | null>(null)
  const [scope, setScope] = useState<ChatScope>(initialNavigation?.scope ?? defaultScope)
  const [currentProjectId, setCurrentProjectId] = useState(
    initialNavigation?.currentProjectId ?? defaultScope.projectId!,
  )
  const [currentRequirementId, setCurrentRequirementId] = useState<string | undefined>(
    initialNavigation?.currentRequirementId ?? defaultScope.requirementId,
  )
  const [entityEditor, setEntityEditor] = useState<EntityEditor | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(preferencesService.sidebar)
  const [mobileNav, setMobileNav] = useState(false)
  const [mobilePanel, setMobilePanel] = useState<'chat' | 'tasks'>(
    initialNavigation?.mobilePanel ?? 'chat',
  )
  const [split, setSplit] = useState(preferencesService.split)
  const [dragging, setDragging] = useState(false)
  const [selectedTask, setSelectedTask] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [detailDefaultWidth, setDetailDefaultWidth] = useState(640)
  const [detailWidthRatio, setDetailWidthRatio] = useState(preferencesService.detailRatio)
  const [accountAnchor, setAccountAnchor] = useState<HTMLElement | null>(null)
  const [settings, setSettings] = useState(false)
  const [configuredAgent, setConfiguredAgent] = useState<Agent | 'new' | null>(null)
  const [logout, setLogout] = useState(false)
  const [loggedIn, setLoggedIn] = useState(true)
  const [preferences, setPreferences] = useState(preferencesService.load)
  const [notice, setNotice] = useState('')
  const [info, setInfo] = useState<'help' | 'profile' | 'members' | null>(null)
  const [userName, setUserName] = useState('Haibin')
  const [nameDraft, setNameDraft] = useState('Haibin')
  const [createStatus, setCreateStatus] = useState<TaskStatus | null>(null)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskRole, setTaskRole] = useState<QueueRole>('coding')
  const splitRef = useRef<HTMLDivElement>(null)
  const taskOpenerRef = useRef<HTMLElement | null>(null)
  const dirtySpec = useRef<string | undefined>(undefined)
  const [specRunning, setSpecRunning] = useState(false)
  const [lastTaskId, setLastTaskId] = useState('T-24')
  const compact = useMediaQuery('(max-width: 1199px)')
  const mobile = useMediaQuery('(max-width: 899px)')
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  // Normalize against the expanded sidebar so collapsing it gives all released space to Todo.
  const referenceWidth = Math.max(1, viewportWidth - 296 - 1)
  const workspaceWidth = viewportWidth - (!compact && sidebarVisible ? 296 : 56) - 1
  const chatWidth = Math.max(
    minimumPaneWidth,
    Math.min(workspaceWidth - minimumPaneWidth, split * referenceWidth),
  )
  const splitValueRef = useRef(split)
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    let disposed = false
    function receive(value: AppData) {
      if (disposed) return
      setData(value)
      const pending = pendingNavigation.current
      if (!pending || !projectsReady.current || value.projectError) return
      const saved = pending.scope
      if (saved.agentId && (value.agentLoading || value.agentError)) return
      if ((saved.specId || pending.selectedTask) && (!value.workflow || value.workflowError)) return
      const spec = value.workflow?.specs.find((item) => item.id === saved.specId)
      const agent = value.agents.find((item) => item.id === saved.agentId)
      const requirement = value.requirements.find(
        (item) => item.id === (spec?.requirement_id ?? saved.requirementId),
      )
      const project = value.projects.find(
        (item) =>
          item.id === (requirement?.projectId ?? saved.projectId ?? pending.currentProjectId),
      )
      const next: ChatScope =
        spec && requirement
          ? {
              id: spec.id,
              title: `${requirement.title} - ${spec.title}`,
              label: 'Spec',
              specId: spec.id,
              projectId: spec.project_id,
              requirementId: requirement.id,
            }
          : agent
            ? { id: `agent-${agent.id}`, title: agent.name, label: 'Agent 对话', agentId: agent.id }
            : requirement
              ? {
                  id: requirement.id,
                  title: requirement.title,
                  label: '当前需求',
                  projectId: requirement.projectId,
                  requirementId: requirement.id,
                }
              : {
                  ...defaultScope,
                  ...(project ? { projectId: project.id, label: '当前项目' } : {}),
                }
      setScope(next)
      setCurrentProjectId(project?.id ?? '')
      setCurrentRequirementId(
        requirement?.id ??
          value.requirements.find(
            (item) => item.id === pending.currentRequirementId && item.projectId === project?.id,
          )?.id,
      )
      const task = value.tasks.find((item) => item.id === pending.selectedTask)
      setSelectedTask(task?.id ?? null)
      if (task) {
        setLastTaskId(task.id)
        setExpanded(pending.expanded)
      }
      setNavigationReady(true)
      pendingNavigation.current = null
    }
    void reinService.getData().then((value) => {
      projectsReady.current = true
      receive(value)
    })
    const unsubscribe = reinService.subscribe(receive)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])
  useEffect(() => {
    if (navigationReady)
      preferencesService.setNavigation({
        scope,
        currentProjectId,
        currentRequirementId,
        selectedTask,
        expanded,
        mobilePanel,
      })
  }, [
    navigationReady,
    scope,
    currentProjectId,
    currentRequirementId,
    selectedTask,
    expanded,
    mobilePanel,
  ])
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        if (compact) setMobileNav(true)
        else setSidebarVisible(true)
        window.setTimeout(
          () => document.querySelector<HTMLInputElement>('[aria-label="搜索项目和需求"]')?.focus(),
          80,
        )
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [compact])
  function toggleSidebar() {
    if (compact) setMobileNav((v) => !v)
    else {
      setSidebarVisible((v) => !v)
      preferencesService.setSidebar(!sidebarVisible)
    }
  }
  function changeScope(next: ChatScope) {
    if (dirtySpec.current && !window.confirm('Spec 文档尚未保存，放弃更改并切换？')) return
    dirtySpec.current = undefined
    pendingNavigation.current = null
    setNavigationReady(true)
    if (next.projectId) {
      setCurrentProjectId(next.projectId)
      setCurrentRequirementId(
        next.requirementId ??
          (next.projectId === currentProjectId
            ? currentRequirementId
            : data?.requirements.find((r) => r.projectId === next.projectId)?.id),
      )
    }
    setMobilePanel('chat')
    setScope(next)
    setSelectedTask(null)
    setMobileNav(false)
  }
  function showTask(id: string) {
    pendingNavigation.current = null
    setNavigationReady(true)
    taskOpenerRef.current = document.activeElement as HTMLElement
    const titleRight = splitRef.current
      ?.querySelector('.task-panel h2')
      ?.getBoundingClientRect().right
    setDetailDefaultWidth(
      !mobile && titleRight ? window.innerWidth - titleRight : window.innerWidth,
    )
    setLastTaskId(id)
    setSelectedTask(id)
    setExpanded(false)
  }
  function closeTask() {
    setSelectedTask(null)
    requestAnimationFrame(() => taskOpenerRef.current?.focus())
  }
  function adjustSplit(clientX: number) {
    const rect = splitRef.current?.getBoundingClientRect()
    if (!rect) return
    const next =
      Math.max(
        minimumPaneWidth,
        Math.min(rect.width - 1 - minimumPaneWidth, clientX - rect.left),
      ) / referenceWidth
    setSplit(next)
    splitValueRef.current = next
  }
  const notify = (text: string) => setNotice(text)
  const snackbar = (
    <Snackbar
      open={!!notice}
      autoHideDuration={3500}
      onClose={(_, reason) => {
        if (reason !== 'clickaway') setNotice('')
      }}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert severity="info" onClose={() => setNotice('')} sx={{ fontSize: 12 }}>
        {notice}
      </Alert>
    </Snackbar>
  )
  if (!loggedIn)
    return (
      <>
        <Login
          onLogin={() => {
            setLoggedIn(true)
            notify('已进入 Rein')
          }}
          notify={notify}
        />
        {snackbar}
      </>
    )
  if (!data || (!navigationReady && !data.projectError && !data.workflowError && !data.agentError))
    return (
      <div className="app-loading">
        <CircularProgress size={22} />
        <span>正在载入 Rein…</span>
      </div>
    )
  const sidebarProps = {
    data,
    scope,
    currentProjectId,
    currentRequirementId,
    onScope: changeScope,
    onHide: toggleSidebar,
    onAccount: setAccountAnchor,
    userName,
    onProject: (project?: Project) => setEntityEditor({ kind: 'project', project }),
    onRequirement: (projectId: string, requirement?: Requirement) =>
      setEntityEditor({ kind: 'requirement', projectId, requirement }),
    onSpec: (requirement: Requirement) =>
      setEntityEditor({ kind: 'spec', projectId: requirement.projectId, requirement }),
    onAgentSettings: (agent: Agent) => setConfiguredAgent(agent),
    onCreateAgent: () => setConfiguredAgent('new'),
  }
  const selectedAgent = data.agents.find((agent) => agent.id === scope.agentId)
  const selectedSpec = data.workflow?.specs.find((spec) => spec.id === scope.specId)
  const mainAgent = data.agents.find((agent) => agent.id === data.workflow?.settings.main_agent)
  const sidebar = <Sidebar {...sidebarProps} />
  const workspace = (
    <div
      className={`app-shell ${dragging ? 'is-resizing' : ''} ${preferences.fontSize.startsWith('14') ? 'font-standard' : ''}`}
      style={
        {
          '--task-todo': statusColors.todo,
          '--task-running': statusColors.running,
          '--task-done': statusColors.done,
          '--waiting-bg': statusColors.waitingBackground,
          '--waiting-border': statusColors.waitingBorder,
          '--waiting-text': statusColors.waitingText,
          '--waiting-badge': statusColors.waitingBadge,
        } as CSSProperties
      }
    >
      {!compact && sidebarVisible ? sidebar : <SidebarRail {...sidebarProps} />}
      <Drawer
        open={compact && mobileNav}
        onClose={() => setMobileNav(false)}
        slotProps={{ paper: { sx: { width: 296, maxWidth: 'calc(100vw - 40px)' } } }}
      >
        {sidebar}
      </Drawer>
      <main className="main-workspace">
        {mobile && (
          <div className="compact-toolbar">
            <Icon name="layers" size={20} />
            <span>Rein</span>
            <span className="spacer" />
            {mobile && (
              <div className="mobile-view-switch">
                <Button
                  variant={mobilePanel === 'chat' ? 'contained' : 'text'}
                  onClick={() => setMobilePanel('chat')}
                >
                  {selectedSpec ? '主 Agent' : '群聊'}
                </Button>
                <Button
                  variant={mobilePanel === 'tasks' ? 'contained' : 'text'}
                  onClick={() => setMobilePanel('tasks')}
                >
                  {selectedAgent ? 'Memory' : selectedSpec ? 'Spec' : '任务'}
                </Button>
              </div>
            )}
          </div>
        )}
        <div
          className={`split-layout ${mobile ? `mobile-show-${mobilePanel}` : ''}`}
          ref={splitRef}
          style={{
            gridTemplateColumns: mobile
              ? undefined
              : `${chatWidth}px 1px minmax(${minimumPaneWidth}px, 1fr)`,
          }}
        >
          {selectedSpec ? (
            mainAgent ? (
              <AgentChat
                key={`${selectedSpec.id}-${mainAgent.id}`}
                spec={selectedSpec}
                hasUnsavedSpec={() => dirtySpec.current === selectedSpec.id}
                onActiveChange={setSpecRunning}
                messages={data.workflow?.messages?.filter(
                  (message) => message.spec_id === selectedSpec.id,
                )}
                members={data.agents}
                workflow={data.workflow}
                onTask={showTask}
                title={scope.title}
                agent={mainAgent}
                userName={userName}
                sendMode={preferences.sendMode}
                onSettings={() => setSettings(true)}
              />
            ) : (
              <section className="chat-panel">
                <header className="panel-header">
                  <Icon name="spec" />
                  <h1>{scope.title}</h1>
                  <span className="spacer" />
                  <Action label="Spec 配置" icon="settings" onClick={() => setSettings(true)} />
                </header>
                <div className="empty-message">
                  <Icon name="agents" />
                  <p>请先设置主 Agent</p>
                  <Button onClick={() => setSettings(true)}>打开系统配置</Button>
                </div>
              </section>
            )
          ) : (
            <Chat
              data={data}
              scope={scope}
              onTask={showTask}
              onMembers={() => setInfo('members')}
              notify={notify}
              sendMode={preferences.sendMode}
              userName={userName}
              onSettings={() => setSettings(true)}
            />
          )}
          <div
            className="split-divider"
            role="separator"
            aria-label="调整聊天与任务栏宽度"
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((chatWidth / workspaceWidth) * 100)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault()
                const rect = splitRef.current!.getBoundingClientRect()
                adjustSplit(rect.left + chatWidth + (e.key === 'ArrowRight' ? 24 : -24))
                preferencesService.setSplit(splitValueRef.current)
              }
            }}
            onPointerDown={(e) => {
              e.preventDefault()
              e.currentTarget.setPointerCapture(e.pointerId)
              setDragging(true)
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) adjustSplit(e.clientX)
            }}
            onPointerUp={(e) => {
              e.currentTarget.releasePointerCapture(e.pointerId)
              setDragging(false)
              preferencesService.setSplit(splitValueRef.current)
            }}
            onPointerCancel={() => setDragging(false)}
            onLostPointerCapture={() => setDragging(false)}
          >
            <span className="split-handle">
              <Icon name="drag" size={14} />
            </span>
          </div>
          {selectedAgent ? (
            <MemoryPanel agent={selectedAgent} />
          ) : selectedSpec ? (
            <SpecPanel
              key={selectedSpec.id}
              spec={selectedSpec}
              agentRunning={specRunning}
              data={data}
              onTask={showTask}
              onSettings={() => setSettings(true)}
              notify={notify}
              onDirtyChange={(dirty) => {
                if (dirty) dirtySpec.current = selectedSpec.id
                else if (dirtySpec.current === selectedSpec.id) dirtySpec.current = undefined
              }}
            />
          ) : (
            <TaskPanel
              data={data}
              scope={scope}
              selectedId={selectedTask ?? lastTaskId}
              onTask={showTask}
              onCreate={() => {
                setCreateStatus('todo')
                setTaskTitle('')
                setTaskRole('coding')
              }}
              notify={notify}
              onSettings={() => setSettings(true)}
              onSpec={(id) => {
                const spec = data.workflow?.specs.find((spec) => spec.id === id)
                const requirement = data.requirements.find(
                  (requirement) => requirement.id === spec?.requirement_id,
                )
                if (spec && requirement)
                  changeScope({
                    id: spec.id,
                    title: `${requirement.title} - ${spec.title}`,
                    label: 'Spec',
                    projectId: spec.project_id,
                    requirementId: spec.requirement_id,
                    specId: spec.id,
                  })
              }}
            />
          )}
        </div>
      </main>
      <TaskDetails
        onTask={setSelectedTask}
        key={selectedTask ?? 'closed'}
        data={data}
        task={data.tasks.find((t) => t.id === selectedTask)}
        expanded={expanded}
        defaultWidth={detailDefaultWidth}
        todoWidth={mobile ? viewportWidth : workspaceWidth - chatWidth}
        panelLabel={selectedSpec ? 'Spec' : 'Todo'}
        chatLabel={selectedSpec ? '对话' : '群聊'}
        widthRatio={detailWidthRatio}
        onWidthRatioChange={(ratio) => {
          setDetailWidthRatio(ratio)
          preferencesService.setDetailRatio(ratio)
        }}
        availableLeft={!compact && sidebarVisible ? 296 : 56}
        onExpand={() => setExpanded((v) => !v)}
        onClose={closeTask}
        notify={notify}
      />
      <Menu
        anchorEl={accountAnchor}
        open={!!accountAnchor}
        onClose={() => setAccountAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{
          paper: {
            className: 'account-menu',
            sx: {
              width: 264,
              padding: '6px',
              border: '1px solid #e5e8ef',
              borderRadius: '6px',
              boxShadow: '0 6px 18px #1726401f',
              marginTop: compact ? '8px' : '-10px',
            },
          },
        }}
      >
        {[
          {
            label: '个人',
            icon: 'person',
            action: () => {
              setNameDraft(userName)
              setInfo('profile')
            },
          },
          { label: '设置', icon: 'settings', action: () => setSettings(true) },
          { label: '帮助', icon: 'help', action: () => setInfo('help') },
        ].map((item) => (
          <MenuItem
            key={item.label}
            onClick={() => {
              setAccountAnchor(null)
              item.action()
            }}
          >
            <Icon name={item.icon} />
            {item.label}
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          onClick={() => {
            setAccountAnchor(null)
            setLogout(true)
          }}
        >
          <Icon name="logout" />
          退出登录
        </MenuItem>
      </Menu>
      <Settings
        open={settings}
        onClose={() => setSettings(false)}
        value={preferences}
        onChange={(next) => {
          setPreferences(next)
          return preferencesService.save(next)
        }}
        notify={notify}
      />
      <Dialog
        open={logout}
        onClose={() => setLogout(false)}
        className="logout-dialog"
        slotProps={{
          paper: { sx: { width: 440, height: 220, maxWidth: 'calc(100vw - 32px)', margin: 2 } },
        }}
      >
        <DialogTitle>退出登录？</DialogTitle>
        <DialogContent>
          <p>确定要退出 Rein 吗？下次使用时需要重新登录。</p>
        </DialogContent>
        <DialogActions>
          <Button variant="outlined" onClick={() => setLogout(false)}>
            取消
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={() => {
              setLogout(false)
              setSelectedTask(null)
              setSettings(false)
              setMobileNav(false)
              setLoggedIn(false)
            }}
          >
            退出登录
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!info} onClose={() => setInfo(null)} fullWidth maxWidth="sm">
        <DialogTitle className="dialog-title">
          {info === 'profile' ? '个人' : info === 'members' ? '群聊成员' : '帮助'}
          <Action label="关闭对话框" icon="close" onClick={() => setInfo(null)} />
        </DialogTitle>
        <DialogContent>
          {info === 'members' &&
            data.agents.map((a) => (
              <div className="member-row" key={a.id}>
                <AgentAvatar agent={a} />
                <strong>
                  {a.name} · {a.role}
                </strong>
                <span>{a.cli} · Agent</span>
              </div>
            ))}
          {info === 'profile' && (
            <form
              className="profile-form"
              onSubmit={(e) => {
                e.preventDefault()
                setUserName(nameDraft.trim())
                setInfo(null)
                notify('个人资料已更新')
              }}
            >
              <AgentAvatar size={36} />
              <TextField
                label="显示名称"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                required
              />
              <p className="muted">本机用户</p>
              <Button type="submit" variant="contained" disabled={!nameDraft.trim()}>
                保存
              </Button>
            </form>
          )}
          {info === 'help' && (
            <div className="help-content">
              <h3>Rein</h3>
              <p>
                在左侧切换项目与需求，群聊和任务栏会展示对应范围。拖动中间分隔线调整宽度，也可聚焦分隔线后使用左右方向键。
              </p>
              <p>点击任务打开详情，切换活动、CLI 和结果；接管输入后可以向模拟终端发送命令。</p>
              <p>Enter 发送消息，Shift + Enter 换行。配置入口位于个人头像菜单中。</p>
              <Alert severity="info">
                独立 Agent 对话连接本机 reind；Memory、任务终端和结果页中的示意内容仍为界面占位。
              </Alert>
            </div>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={createStatus !== null}
        onClose={() => setCreateStatus(null)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle className="dialog-title">
          新建任务
          <Action label="关闭新建任务" icon="close" onClick={() => setCreateStatus(null)} />
        </DialogTitle>
        <DialogContent>
          <form
            className="create-task-form"
            onSubmit={async (e) => {
              e.preventDefault()
              if (createStatus && taskTitle.trim()) {
                try {
                  await reinService.createTask(
                    scope.requirementId ??
                      data.requirements.find((r) => r.projectId === currentProjectId)?.id ??
                      '',
                    taskTitle.trim(),
                    taskRole,
                  )
                  setCreateStatus(null)
                  notify('任务已创建')
                } catch (error) {
                  notify(error instanceof Error ? error.message : '创建任务失败')
                }
              }
            }}
          >
            <p className="muted">
              {scope.title} · {createStatus && statusLabels[createStatus]}
            </p>
            <label className="create-task-type">
              任务类型
              <select
                aria-label="任务类型"
                value={taskRole}
                onChange={(event) => setTaskRole(event.target.value as QueueRole)}
              >
                <option value="coding">Coding · 开发任务</option>
                <option value="review">Review · 验证任务</option>
              </select>
            </label>
            <TextField
              label="任务名称"
              autoFocus
              required
              fullWidth
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
            />
            <Button type="submit" variant="contained" disabled={!taskTitle.trim()}>
              创建任务
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      {entityEditor && (
        <EntityDialog
          key={`${entityEditor.kind}-${entityEditor.project?.id ?? entityEditor.requirement?.id ?? entityEditor.projectId ?? 'new'}`}
          editor={entityEditor}
          onClose={() => setEntityEditor(null)}
          onSaved={(result) => {
            const editing =
              entityEditor.kind !== 'spec' && !!(entityEditor.project || entityEditor.requirement)
            if (result.kind === 'spec')
              changeScope({
                id: result.id,
                title: `${entityEditor.requirement!.title} - ${result.name}`,
                label: 'Spec',
                projectId: result.projectId,
                requirementId: entityEditor.requirement!.id,
                specId: result.id,
              })
            setEntityEditor(null)
            if (result.kind === 'requirement' && (!editing || scope.id === result.id))
              changeScope({
                id: result.id,
                title: result.name,
                label: '当前需求',
                projectId: result.projectId,
                requirementId: result.id,
              })
            else if (result.kind === 'project' && !editing)
              changeScope({
                id: 'overview',
                title: '选择需求或 Agent',
                label: '当前项目',
                projectId: result.id,
              })
            notify(
              `${result.kind === 'project' ? '项目' : result.kind === 'spec' ? 'Spec' : '需求'}已${editing ? '更新' : '创建'}`,
            )
          }}
        />
      )}
      {configuredAgent && (
        <AgentSettings
          key={configuredAgent === 'new' ? 'new' : configuredAgent.id}
          agent={configuredAgent === 'new' ? undefined : configuredAgent}
          onClose={() => setConfiguredAgent(null)}
          onSaved={(agent) => {
            setScope((previous) =>
              previous.agentId === agent.id ? { ...previous, title: agent.name } : previous,
            )
            if (configuredAgent === 'new') {
              setConfiguredAgent(null)
              notify(`Agent 已保存，请使用 rein agent up ${agent.name} 上线`)
            }
          }}
        />
      )}
      {snackbar}
    </div>
  )
  const specVisible = !selectedTask && !(compact && mobileNav) && (!mobile || mobilePanel === 'tasks')
  return (
    <NodeStatusProvider
      data={data}
      viewedTaskId={selectedTask}
      viewedSpecId={specVisible ? selectedSpec?.id : undefined}
    >
      {workspace}
    </NodeStatusProvider>
  )
}
