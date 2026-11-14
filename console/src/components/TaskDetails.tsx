import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  Tab,
  Tabs,
} from '@mui/material'
import type { AppData, Task, TaskStatus } from '../types'
import type { TaskDraft } from '../services/sdd'
import {
  blockedReason,
  completionError,
  predecessors,
  taskDraft,
  taskNumber,
  taskTypeInfo,
} from '../services/sdd'
import { reinService } from '../services/reinService'
import { Action, Icon, StatusDot } from './shared'
import { statusLabels } from '../constants'
import { TaskTypeBadge } from './TaskTypeBadge'
import { TaskContent } from './TaskContent'

interface Props {
  data: AppData
  task: Task | undefined
  expanded: boolean
  defaultWidth: number
  todoWidth: number
  widthRatio: number | null
  onWidthRatioChange: (ratio: number) => void
  availableLeft: number
  onExpand: () => void
  onClose: () => void
  onTask: (id: string) => void
  notify: (message: string) => void
}
export function TaskDetails({
  data,
  task,
  expanded,
  defaultWidth,
  todoWidth,
  widthRatio,
  onWidthRatioChange,
  availableLeft,
  onExpand,
  onClose,
  onTask,
  notify,
}: Props) {
  const [tab, setTab] = useState(0)
  const [draft, setDraft] = useState(() => taskDraft(task))
  const [baseline, setBaseline] = useState(() => JSON.stringify(taskDraft(task)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const dirty = JSON.stringify(draft) !== baseline
  const requestClose = useCallback(() => {
    if (saving) return
    if (dirty) setDiscard(true)
    else onClose()
  }, [saving, dirty, onClose])
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth)
  const [resizing, setResizing] = useState(false)
  const [dockedToSidebar, setDockedToSidebar] = useState(false)
  const [snappedToTodo, setSnappedToTodo] = useState(false)
  const [returning, setReturning] = useState(false)
  const maximumWidth = Math.max(0, viewportWidth - availableLeft)
  const todoSnapWidth = Math.min(todoWidth, maximumWidth)
  const preferredWidth = widthRatio === null ? defaultWidth : widthRatio * viewportWidth
  // Clamp only the rendered size: a smaller window must not overwrite the saved ratio.
  const normalWidth = snappedToTodo
    ? todoSnapWidth
    : dockedToSidebar
      ? maximumWidth
      : Math.max(Math.min(260, maximumWidth), Math.min(preferredWidth, maximumWidth))
  const minimumWidth = Math.min(360, defaultWidth, normalWidth, maximumWidth)
  const renderedWidth = expanded ? maximumWidth : normalWidth
  const restoringCustom = !expanded && snappedToTodo && returning
  const restoringTodo = expanded || renderedWidth >= maximumWidth - 1
  const coversTodo = renderedWidth >= todoSnapWidth - 1
  const widthActionLabel = restoringCustom
    ? '恢复自定义宽度'
    : restoringTodo
      ? '缩回 Todo 栏'
      : coversTodo
        ? '覆盖群聊栏'
        : '覆盖 Todo 栏'
  const previousLayout = useRef({ availableLeft, viewportWidth, maximumWidth, normalWidth })
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
        requestClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [requestClose])
  useEffect(() => {
    if (!task) return
    const outside = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element) || detailRef.current?.contains(target)) return
      if (target.closest('.MuiDialog-root, .MuiPopover-root, .MuiMenu-root, .sidebar-toggle'))
        return
      if (saving || dirty) {
        event.preventDefault()
        event.stopPropagation()
        if (!saving) setDiscard(true)
      } else if (event.type === 'pointerdown') onClose()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('click', outside, true)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('click', outside, true)
    }
  }, [task, dirty, saving, onClose])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  if (!task) return null
  const related = data.tasks.filter((value) => value.requirementId === task.requirementId)
  const dependencies = predecessors(task, related)
  const blocked = blockedReason(task, related)
  const completion = completionError({ ...task, ...draft }, related)
  const readOnly = task.status === 'done'
  const info = task.type ? taskTypeInfo[task.type] : undefined
  const canRepair =
    task.type === 'verification' &&
    task.status === 'running' &&
    draft.checks.some((check) => check.status === 'failed')
  async function save(status?: TaskStatus) {
    setSaving(true)
    setError('')
    try {
      const action =
        status === 'done'
          ? task!.type === 'verification'
            ? '确认验收通过'
            : '确认完成任务'
          : status === 'running'
            ? readOnly
              ? '重新打开任务'
              : '开始任务'
            : '保存草稿'
      const saved = await reinService.saveTask(
        task!.id,
        { ...draft, ...(status ? { status } : {}) },
        action,
      )
      const next = taskDraft(saved)
      setDraft(next)
      setBaseline(JSON.stringify(next))
      notify(
        status === 'done'
          ? '任务已完成，后续阶段已解锁'
          : status === 'running'
            ? '任务已开始'
            : '草稿已保存',
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }
  async function repair() {
    const development = related.find((value) => value.type === 'tasks')
    if (!development) return
    setSaving(true)
    setError('')
    try {
      await reinService.saveTask(task!.id, draft, '记录未通过的验收结果')
      await reinService.moveTask(development.id, 'running')
      onTask(development.id)
      notify('开发任务已重新打开，修复后请重新验证。')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法返回开发任务。')
    } finally {
      setSaving(false)
    }
  }
  function changeDraft(patch: Partial<TaskDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
    setError('')
  }
  function openDependency(id: string) {
    if (dirty) {
      setError('请先保存草稿，再切换到前置任务。')
      return
    }
    onTask(id)
  }
  function resize(nextWidth: number) {
    const next = Math.max(minimumWidth, Math.min(maximumWidth, nextWidth))
    setSnappedToTodo(false)
    setReturning(false)
    setDockedToSidebar(false)
    onWidthRatioChange(next / viewportWidth)
    if (expanded) onExpand()
  }
  function cycleWidth() {
    setDockedToSidebar(false)
    // Snap widths never replace the saved custom drag position.
    if (restoringCustom) {
      setSnappedToTodo(false)
      setReturning(false)
    } else if (restoringTodo) {
      if (expanded) onExpand()
      setSnappedToTodo(true)
      setReturning(true)
    } else if (!coversTodo) {
      setSnappedToTodo(true)
      setReturning(false)
    } else onExpand()
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
            title="双击依次覆盖 Todo、群聊，再逐级恢复；也可按 Enter"
            aria-orientation="vertical"
            aria-valuemin={Math.round(minimumWidth)}
            aria-valuemax={maximumWidth}
            aria-valuenow={Math.round(renderedWidth)}
            tabIndex={0}
            onDoubleClick={cycleWidth}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                cycleWidth()
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
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
            <TaskTypeBadge type={task.type} />
            <small>{task.displayId ?? taskNumber(task)}</small>
            <h2>{task.title}</h2>
            <span className="spacer" />
            <Action label={widthActionLabel} icon="expand" onClick={cycleWidth} />
            <Action label="关闭任务详情" icon="close" onClick={requestClose} />
          </header>
          <div className="detail-participants sdd-participants">
            <span className="sdd-task-status">
              <StatusDot status={task.status} />
              {statusLabels[task.status]}
            </span>
            <span className="spacer" />
            <label htmlFor={`task-agent-${task.id}`}>负责人</label>
            <select
              id={`task-agent-${task.id}`}
              value={draft.agent_id}
              disabled={readOnly || saving}
              onChange={(event) => changeDraft({ agent_id: event.target.value })}
            >
              <option value="">未分配</option>
              {draft.agent_id && !data.agents.some((agent) => agent.id === draft.agent_id) && (
                <option value={draft.agent_id}>{draft.agent_id}（已移除）</option>
              )}
              {data.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </div>
          {!!dependencies.length && (
            <div className="sdd-dependencies" aria-label="前置任务">
              <span>前置任务</span>
              {dependencies.map((value) => (
                <Button key={value.id} onClick={() => openDependency(value.id)}>
                  {taskNumber(value)} {value.title}
                  <span className={value.status === 'done' ? 'sdd-success' : 'muted'}>
                    {value.status === 'done' ? '已完成' : '未完成'}
                  </span>
                </Button>
              ))}
            </div>
          )}
          {error && (
            <Alert severity="error" className="sdd-task-alert">
              {error}
            </Alert>
          )}
          <div className="detail-tabs">
            <Tabs
              value={tab}
              onChange={(_, value: number) => setTab(value)}
              aria-label="任务详情页签"
            >
              <Tab
                label={info?.tab ?? '任务说明'}
                id="detail-tab-0"
                aria-controls="detail-panel-0"
              />
              <Tab label="工作记录" id="detail-tab-1" aria-controls="detail-panel-1" />
            </Tabs>
          </div>
          <div
            className="detail-body sdd-detail-body"
            role="tabpanel"
            id={`detail-panel-${tab}`}
            aria-labelledby={`detail-tab-${tab}`}
          >
            {tab === 0 ? (
              <fieldset className="sdd-editor-fields" disabled={saving}>
                <TaskContent task={task} tasks={data.tasks} draft={draft} onChange={changeDraft} />
              </fieldset>
            ) : (
              <div className="sdd-task-history">
                <h3>工作记录</h3>
                <p className="sdd-section-note">
                  这里记录任务的创建、保存和确认操作。负责人分配不会自动启动 Agent。
                </p>
                {task.history?.length ? (
                  [...task.history].reverse().map((item, index) => (
                    <div className="sdd-history-row" key={`${item.at}-${index}`}>
                      <time dateTime={new Date(item.at).toISOString()}>
                        {new Date(item.at).toLocaleString('zh-CN')}
                      </time>
                      <span>{item.message}</span>
                    </div>
                  ))
                ) : (
                  <p className="muted">尚无工作记录。</p>
                )}
              </div>
            )}
          </div>
          <footer className="detail-footer sdd-detail-footer">
            <div className="readonly-status">
              <Icon name={blocked ? 'lock' : 'info'} size={13} />
              <span>
                {blocked ||
                  (readOnly
                    ? '已确认；重新打开会将后续阶段移回待开始。'
                    : task.status === 'running' && completion
                      ? completion
                      : dirty
                        ? '有尚未保存的更改'
                        : '任务进度与验收结果由你确认。')}
              </span>
            </div>
            <div className="detail-controls">
              {!readOnly && (
                <Button
                  variant="outlined"
                  disabled={!dirty || saving}
                  onClick={() => {
                    void save()
                  }}
                >
                  保存草稿
                </Button>
              )}
              {canRepair && (
                <Button
                  disabled={saving}
                  onClick={() => {
                    void repair()
                  }}
                >
                  保存并返回开发修复
                </Button>
              )}
              <span className="spacer" />
              {readOnly ? (
                <Button
                  variant="outlined"
                  disabled={saving}
                  onClick={() => {
                    void save('running')
                  }}
                >
                  重新打开
                </Button>
              ) : task.status === 'todo' ? (
                <Button
                  variant="contained"
                  disabled={!!blocked || saving}
                  onClick={() => {
                    void save('running')
                  }}
                >
                  开始任务
                </Button>
              ) : (
                <Button
                  variant="contained"
                  disabled={!!completion || saving}
                  onClick={() => {
                    void save('done')
                  }}
                >
                  {task.type === 'verification'
                    ? '确认验收'
                    : task.type === 'tasks'
                      ? '完成开发'
                      : '确认并完成'}
                </Button>
              )}
            </div>
          </footer>
        </section>
      </Drawer>
      <Dialog
        open={discard}
        onClose={() => setDiscard(false)}
        maxWidth="xs"
        fullWidth
        aria-labelledby="discard-task-title"
      >
        <DialogTitle id="discard-task-title">草稿尚未保存</DialogTitle>
        <DialogContent>关闭任务详情会丢失本次尚未保存的更改。</DialogContent>
        <DialogActions>
          <Button onClick={() => setDiscard(false)}>继续编辑</Button>
          <Button
            color="error"
            onClick={() => {
              setDiscard(false)
              onClose()
            }}
          >
            放弃更改并关闭
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
