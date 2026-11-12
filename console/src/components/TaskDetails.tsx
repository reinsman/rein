import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Drawer,
  InputBase,
  MenuItem,
  Select,
  Tab,
  Tabs,
} from '@mui/material'
import type { AppData, Task, TaskStatus } from '../types'
import { reinService } from '../services/reinService'
import { Action, AgentAvatar, Icon, StateIcon } from './shared'
import { statusLabels } from '../constants'
import { SpecProgress } from './SpecProgress'
import { TaskResults } from './TaskResults'

interface Props {
  data: AppData
  task: Task | undefined
  expanded: boolean
  defaultWidth: number
  widthRatio: number | null
  onWidthRatioChange: (ratio: number) => void
  availableLeft: number
  onExpand: () => void
  onClose: () => void
  onTask: (id: string) => void
  onStatus: (task: Task, status: TaskStatus) => void
  notify: (message: string) => void
}
export function TaskDetails({
  data,
  task,
  expanded,
  defaultWidth,
  widthRatio,
  onWidthRatioChange,
  availableLeft,
  onExpand,
  onClose,
  onTask,
  onStatus,
  notify,
}: Props) {
  const [tab, setTab] = useState(0)
  const [agentId, setAgentId] = useState(task?.agentId ?? 'sam')
  const [takeover, setTakeover] = useState(false)
  const [command, setCommand] = useState('')
  const [history, setHistory] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth)
  const [resizing, setResizing] = useState(false)
  const [dockedToSidebar, setDockedToSidebar] = useState(false)
  const maximumWidth = Math.max(0, viewportWidth - availableLeft)
  const preferredWidth = widthRatio === null ? defaultWidth : widthRatio * viewportWidth
  // Clamp only the rendered size: a smaller window must not overwrite the saved ratio.
  const normalWidth = dockedToSidebar
    ? maximumWidth
    : Math.max(Math.min(260, maximumWidth), Math.min(preferredWidth, maximumWidth))
  const minimumWidth = Math.min(360, defaultWidth, normalWidth, maximumWidth)
  const renderedWidth = expanded ? maximumWidth : normalWidth
  const previousLayout = useRef({ availableLeft, viewportWidth, maximumWidth, normalWidth })
  const terminalRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const previous = previousLayout.current
    // Follow a sidebar toggle only when the normal detail edge was already touching it.
    // Responsive viewport constraints alone must not replace the user's preferred width.
    if (previous.availableLeft !== availableLeft && previous.viewportWidth === viewportWidth)
      setDockedToSidebar(Math.abs(previous.normalWidth - previous.maximumWidth) < 1)
    previousLayout.current = { availableLeft, viewportWidth, maximumWidth, normalWidth }
  }, [availableLeft, viewportWidth, maximumWidth, normalWidth])
  useEffect(() => {
    detailRef.current?.focus()
  }, [])
  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('[role="dialog"], [role="menu"]'))
        onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])
  useEffect(() => {
    if (!task) return
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element) || detailRef.current?.contains(target)) return
      if (target.closest('.MuiDialog-root, .MuiPopover-root, .MuiMenu-root')) return
      if (target.closest('.sidebar-toggle')) return
      onClose()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [task, onClose])
  const session = data.sessions.find((s) => s.taskId === task?.id && s.agentId === agentId)
  useEffect(() => {
    if (terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight
  }, [session?.lines.length, agentId])
  if (!task) return null
  const owner = data.agents.find((a) => a.id === task.agentId)
  const reviewer = data.agents.find((a) => a.id === task.reviewerId)
  const canInput = takeover && task.status === 'running' && task.execution !== 'stopped'
  function resize(nextWidth: number) {
    const next = Math.max(minimumWidth, Math.min(maximumWidth, nextWidth))
    setDockedToSidebar(false)
    onWidthRatioChange(next / viewportWidth)
    if (expanded) onExpand()
  }
  return (
    <>
      <Drawer
        anchor="right"
        variant="persistent"
        open
        slotProps={{
          root: { sx: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 1200 } },
          paper: {
            sx: {
              pointerEvents: 'auto',
              width: expanded ? `calc(100vw - ${availableLeft}px)` : normalWidth,
              height: '100dvh',
              boxSizing: 'border-box',
              borderLeft: '1px solid #e5e8ef',
              boxShadow: '-6px 0 18px #1726401f',
              overflow: 'visible',
            },
          },
        }}
      >
        <section
          className={`task-detail ${resizing ? 'is-resizing' : ''}`}
          aria-label="任务详情"
          ref={detailRef}
          tabIndex={-1}
        >
          <div
            className="detail-resize-handle"
            role="separator"
            aria-label="调整任务详情宽度"
            aria-orientation="vertical"
            aria-valuemin={Math.round(minimumWidth)}
            aria-valuemax={maximumWidth}
            aria-valuenow={Math.round(renderedWidth)}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault()
                resize(renderedWidth + (event.key === 'ArrowLeft' ? 24 : -24))
              }
            }}
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              setResizing(true)
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                resize(window.innerWidth - event.clientX)
            }}
            onPointerUp={(event) => {
              event.currentTarget.releasePointerCapture(event.pointerId)
              setResizing(false)
            }}
            onPointerCancel={() => setResizing(false)}
            onLostPointerCapture={() => setResizing(false)}
          >
            <span className="split-handle">
              <Icon name="drag" size={14} />
            </span>
          </div>
          <header className="panel-header detail-header">
            <Icon name="detailDoc" size={20} />
            <small>#{task.displayId ?? task.id}</small>
            <h2>{task.title}</h2>
            <span className="spacer" />
            <Action
              label={expanded ? '恢复抽屉宽度' : '展开任务详情'}
              icon="expand"
              onClick={onExpand}
            />
            <Action label="关闭任务详情" icon="close" onClick={onClose} />
          </header>
          <div className="detail-participants">
            <span className={`detail-status ${task.execution}`}>
              <StateIcon state={task.execution} />
              {statusLabels[task.status]}
            </span>
            <AgentAvatar agent={owner} size={18} />
            <span>
              {owner?.name} · {owner?.role}
            </span>
            {reviewer && (
              <>
                <AgentAvatar agent={reviewer} size={18} />
                <span>
                  {reviewer.name} · {reviewer.role}
                </span>
              </>
            )}
          </div>
          <p className="detail-description">{task.description}</p>
          <div className="detail-tabs">
            <Tabs
              value={tab}
              onChange={(_, value: number) => setTab(value)}
              aria-label="任务详情页签"
            >
              <Tab label="任务" id="detail-tab-0" aria-controls="detail-panel-0" />
              <Tab label="CLI" id="detail-tab-1" aria-controls="detail-panel-1" />
              <Tab label="结果" id="detail-tab-2" aria-controls="detail-panel-2" />
            </Tabs>
            <span className="spacer" />
            {tab === 1 && (
              <>
                <Select
                  className="agent-select"
                  size="small"
                  value={agentId}
                  onChange={(e) => {
                    setAgentId(e.target.value)
                    setTakeover(false)
                  }}
                  inputProps={{ 'aria-label': '切换 Agent 会话' }}
                >
                  {data.agents.map((a) => (
                    <MenuItem value={a.id} key={a.id}>
                      {a.name}
                    </MenuItem>
                  ))}
                </Select>
                <Button
                  variant="outlined"
                  startIcon={<Icon name="keyboard" />}
                  onClick={() => {
                    setTab(1)
                    setTakeover(!takeover)
                    notify(takeover ? '已恢复只读模式' : '已接管模拟终端输入；不会执行真实命令')
                  }}
                  disabled={task.status !== 'running' || task.execution === 'stopped'}
                >
                  {takeover ? '释放输入' : '接管输入'}
                </Button>
              </>
            )}
          </div>
          <div
            className="detail-body"
            role="tabpanel"
            id={`detail-panel-${tab}`}
            aria-labelledby={`detail-tab-${tab}`}
          >
            {tab === 1 && (
              <div className="terminal">
                <div className="terminal-scroll" ref={terminalRef}>
                  <div className="terminal-status">
                    <StateIcon state={task.execution} />
                    <span>
                      {task.execution === 'executing'
                        ? '正在执行回归测试…'
                        : task.execution === 'waiting'
                          ? '等待用户回复…'
                          : task.statusText}
                    </span>
                  </div>
                  <div className="terminal-lines" role="log" aria-label="模拟终端输出">
                    {session?.lines.map((line, i) => (
                      <div key={i} className={line.tone ?? ''}>
                        {line.text || '\u00a0'}
                      </div>
                    )) ?? <div>此 Agent 尚无会话记录。</div>}
                  </div>
                </div>
                {canInput && (
                  <form
                    className="terminal-input"
                    onSubmit={async (e) => {
                      e.preventDefault()
                      if (!command.trim()) return
                      await reinService.command(task.id, agentId, command)
                      setCommand('')
                    }}
                  >
                    <span>$</span>
                    <InputBase
                      autoFocus
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      placeholder="输入模拟命令…"
                      inputProps={{ 'aria-label': '模拟终端命令' }}
                    />
                    <Button type="submit" disabled={!command.trim()}>
                      发送
                    </Button>
                  </form>
                )}
              </div>
            )}
            {tab === 0 && (
              <div className="activity-list">
                <SpecProgress task={task} tasks={data.tasks} onTask={onTask} />
                <h3 className="activity-log-heading">执行记录</h3>
                {session?.activities.map((item, i) => (
                  <div className="activity-row" key={i}>
                    <span className="activity-dot" />
                    <time>{item.time}</time>
                    <span>{item.text}</span>
                  </div>
                )) ?? <p>此 Agent 尚无活动。</p>}
                <p className="muted">活动由前端模拟数据生成。</p>
              </div>
            )}
            {tab === 2 && <TaskResults task={task} onStatus={onStatus} />}
          </div>
          <footer className="detail-footer">
            <div className="readonly-status">
              <Icon name="info" size={13} />
              <span>
                {tab === 1
                  ? takeover
                    ? '已接管输入'
                    : '当前只读 · 接管后可直接交互'
                  : '步骤进度随 Agent 执行状态更新'}
                <span className="simulation-label"> · {tab === 1 ? '模拟终端' : '模拟数据'}</span>
              </span>
            </div>
            <div className="detail-controls">
              {task.status === 'todo' ? (
                <Button
                  startIcon={<Icon name="spinner" size={12} />}
                  onClick={() => onStatus(task, 'running')}
                >
                  开始任务
                </Button>
              ) : (
                <Button
                  startIcon={<Icon name="stop" />}
                  disabled={task.status === 'done' || task.execution === 'stopped'}
                  onClick={async () => {
                    await reinService.updateTask(task.id, {
                      status: 'todo',
                      execution: 'stopped',
                      statusText: '已停止',
                    })
                    setTakeover(false)
                    notify('模拟任务已停止')
                  }}
                >
                  停止任务
                </Button>
              )}
              <span className="spacer" />
              <Button startIcon={<Icon name="open" />} onClick={() => setHistory(true)}>
                查看会话记录
              </Button>
            </div>
          </footer>
        </section>
      </Drawer>
      <Dialog open={history} onClose={() => setHistory(false)} fullWidth maxWidth="sm">
        <DialogTitle className="dialog-title">
          会话记录 · #{task.displayId ?? task.id}
          <Action label="关闭会话记录" icon="close" onClick={() => setHistory(false)} />
        </DialogTitle>
        <DialogContent>
          <p className="muted">本地模拟会话，不代表已连接真实 Agent。</p>
          {data.sessions
            .filter((s) => s.taskId === task.id)
            .map((s) => (
              <div className="session-record" key={s.id}>
                <strong>
                  {data.agents.find((a) => a.id === s.agentId)?.name} · {s.startedAt}
                </strong>
                <small>{s.id}</small>
                {s.activities.map((a, i) => (
                  <p key={i}>
                    {a.time}　{a.text}
                  </p>
                ))}
              </div>
            ))}
        </DialogContent>
      </Dialog>
    </>
  )
}
