import { useRef, useState } from 'react'
import { Button, ButtonBase, Menu, MenuItem, Paper } from '@mui/material'
import type { AppData, ChatScope, Task, TaskStatus } from '../types'
import { reinService, taskHasActiveAgent, tasksInScope } from '../services/reinService'
import { Action, AgentAvatar, Icon, StatusDot } from './shared'
import { statusLabels } from '../constants'
import { TaskDependencies } from './TaskDependencies'
import { blockedReason, taskProgress } from '../services/sdd'
import { TaskTypeBadge } from './TaskTypeBadge'
import { HandoffLinks } from './HandoffLinks'
import { NodeStatus } from './NodeStatus'
import { workflowService } from '../services/workflow'

interface Props {
  data: AppData
  scope: ChatScope
  selectedId: string | null
  onTask: (id: string) => void
  onCreate: (status: TaskStatus) => void
  notify: (message: string) => void
  onSpec: (id: string) => void
  onSettings: () => void
}
export function TaskPanel({
  data,
  scope,
  selectedId,
  onTask,
  onCreate,
  notify,
  onSpec,
  onSettings,
}: Props) {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ status: TaskStatus; beforeId?: string } | null>(
    null,
  )
  const dragRef = useRef<string | null>(null)
  const droppedRef = useRef(false)
  async function moveTask(id: string, status: TaskStatus, beforeId?: string) {
    try {
      await reinService.moveTask(id, status, beforeId)
    } catch (error) {
      notify(error instanceof Error ? error.message : '任务移动失败')
    }
  }
  function finishDrop() {
    const id = dragRef.current
    if (id && dropTarget) {
      droppedRef.current = true
      window.setTimeout(() => {
        droppedRef.current = false
      }, 0)
      void moveTask(id, dropTarget.status, dropTarget.beforeId)
    }
    dragRef.current = null
    setDraggedId(null)
    setDropTarget(null)
  }
  const boardRef = useRef<HTMLDivElement>(null)
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null)
  const [filter, setFilter] = useState('all')
  const [taskMenu, setTaskMenu] = useState<{ el: HTMLElement; task: Task } | null>(null)
  const tasks = tasksInScope(data, scope).filter(
    (t) =>
      filter === 'all' || (filter === 'waiting' ? t.execution === 'waiting' : t.agentId === filter),
  )
  return (
    <section className="task-panel" aria-label="任务栏">
      <header className="panel-header">
        <Icon name="checklist" size={20} />
        <h2>Todo</h2>
        <span className="spacer" />
        <Action
          label="筛选任务"
          icon="filter"
          className={filter !== 'all' ? 'active-action' : ''}
          onClick={(e) => setFilterAnchor(e.currentTarget)}
        />
        <Action label="任务栏设置" icon="settings" onClick={onSettings} />
      </header>
      <div className="task-board-scroll">
        <div className="task-groups" ref={boardRef}>
          <TaskDependencies tasks={tasks} boardRef={boardRef} />
          {(Object.keys(statusLabels) as TaskStatus[]).map((status) => (
            <section
              key={status}
              className={`task-group task-group-${status} ${draggedId && dropTarget?.status === status ? 'drop-active' : ''}`}
              onDragOver={(event) => {
                if (!dragRef.current) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropTarget({ status })
              }}
              onDrop={(event) => {
                event.preventDefault()
                finishDrop()
              }}
              aria-label={statusLabels[status]}
            >
              <div className="group-header">
                <StatusDot status={status} />
                <h3>{statusLabels[status]}</h3>
                <small>{tasks.filter((t) => t.status === status).length}</small>
                <span className="spacer" />
                <Action
                  label={`在${statusLabels[status]}中新建任务`}
                  icon="plus"
                  onClick={() => onCreate(status)}
                />
                <Action
                  label={`${statusLabels[status]}分组说明`}
                  onClick={(e) => setFilterAnchor(e.currentTarget)}
                />
              </div>
              <div className="group-cards">
                {tasks
                  .filter((t) => t.status === status)
                  .map((task) => {
                    const agent = data.agents.find((a) => a.id === task.agentId)
                    const blocked = blockedReason(task, data.tasks)
                    return (
                      <Paper
                        data-task-id={task.id}
                        draggable={!task.queue && !taskHasActiveAgent(task)}
                        onDragStart={(event) => {
                          if (task.queue || taskHasActiveAgent(task)) {
                            event.preventDefault()
                            return
                          }
                          dragRef.current = task.id
                          droppedRef.current = false
                          setDraggedId(task.id)
                          event.dataTransfer.setData('text/plain', task.id)
                          event.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => {
                          dragRef.current = null
                          setDraggedId(null)
                          setDropTarget(null)
                        }}
                        onDragOver={(event) => {
                          if (!dragRef.current) return
                          event.preventDefault()
                          event.stopPropagation()
                          const rect = event.currentTarget.getBoundingClientRect()
                          const group = tasks.filter(
                            (t) => t.status === status && t.id !== dragRef.current,
                          )
                          const index = group.findIndex((t) => t.id === task.id)
                          setDropTarget({
                            status,
                            beforeId:
                              event.clientY < rect.top + rect.height / 2
                                ? task.id
                                : group[index + 1]?.id,
                          })
                        }}
                        onDrop={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          finishDrop()
                        }}
                        variant="outlined"
                        className={`task-card ${task.queue?.spec_id ? 'sdd-task-card' : ''} ${task.queue ? `queue-task-card queue-${task.queue.role}` : ''} ${selectedId === task.id ? 'selected' : ''} ${task.execution === 'waiting' ? 'waiting-task' : ''} ${blocked ? 'is-blocked' : ''} ${draggedId === task.id ? 'is-dragging' : ''} ${draggedId && dropTarget?.beforeId === task.id ? 'drop-before' : ''}`}
                        key={task.id}
                      >
                        <div className="task-card-meta">
                          {task.queue ? (
                            <span className="queue-role">
                              <Icon
                                name={task.queue.role === 'coding' ? 'code' : 'shield'}
                                size={13}
                              />
                              {task.queue.role === 'coding' ? 'Coding' : 'Review'}
                            </span>
                          ) : (
                            <TaskTypeBadge type={task.type} />
                          )}
                          {task.queue?.spec_id && (
                            <span className="queue-sdd-mark">
                              <Icon name="spec" size={12} />
                              SDD
                            </span>
                          )}
                          <span className="task-card-number">
                            {task.displayId ?? task.id}
                            <NodeStatus taskId={task.id} source />
                          </span>
                          {task.execution === 'waiting' && (
                            <span className="needs-reply-badge">需你回复</span>
                          )}
                          <Action
                            label={`${task.id}任务操作`}
                            onClick={(e) => setTaskMenu({ el: e.currentTarget, task })}
                          />
                        </div>
                        <ButtonBase
                          className="task-card-main"
                          aria-label={`打开任务 ${task.title}`}
                          onClick={() => {
                            if (!droppedRef.current) onTask(task.id)
                            droppedRef.current = false
                          }}
                        >
                          <strong>{task.title}</strong>
                          {task.type && (
                            <p className="task-card-progress">
                              {taskProgress(
                                task,
                                data.tasks.filter(
                                  (value) => value.requirementId === task.requirementId,
                                ),
                              )}
                            </p>
                          )}
                          <div className={`task-state ${blocked ? 'blocked' : task.execution}`}>
                            {blocked ? (
                              <Icon name="lock" size={13} />
                            ) : (
                              <StatusDot status={task.status} />
                            )}
                            <span>{blocked || task.statusText}</span>
                          </div>
                          <div className="task-assignee">
                            {agent ? (
                              <AgentAvatar agent={agent} size={18} />
                            ) : (
                              <Icon name="person" size={16} />
                            )}
                            <span>{agent?.name ?? '未分配'}</span>
                          </div>
                        </ButtonBase>
                        {task.queue && (
                          <>
                            <div className="queue-source">
                              {task.queue.spec_id ? (
                                <button onClick={() => onSpec(task.queue!.spec_id!)}>
                                  <Icon name="spec" size={12} />
                                  {
                                    data.workflow?.specs.find(
                                      (spec) => spec.id === task.queue?.spec_id,
                                    )?.title
                                  }
                                </button>
                              ) : (
                                '直接任务'
                              )}
                            </div>
                            {task.queue.error && <p className="queue-error">{task.queue.error}</p>}
                            <HandoffLinks task={task.queue} workflow={data.workflow} />
                            {task.status !== 'done' && (
                              <div className="queue-controls">
                                <Button
                                  size="small"
                                  onClick={() =>
                                    void workflowService
                                      .taskAction(
                                        task.id,
                                        taskHasActiveAgent(task) ? 'stop' : 'start',
                                      )
                                      .then(() => reinService.refreshWorkflow())
                                      .catch((error) => notify(String(error)))
                                  }
                                >
                                  {taskHasActiveAgent(task)
                                    ? '停止任务'
                                    : task.queue.paused || task.queue.error
                                      ? '重试任务'
                                      : '开始任务'}
                                </Button>
                              </div>
                            )}
                          </>
                        )}
                      </Paper>
                    )
                  })}
                {!tasks.some((t) => t.status === status) && <p className="group-empty">暂无任务</p>}
              </div>
            </section>
          ))}
        </div>
      </div>
      <Menu anchorEl={filterAnchor} open={!!filterAnchor} onClose={() => setFilterAnchor(null)}>
        {[
          { id: 'all', label: '全部任务' },
          { id: 'waiting', label: '等待回复' },
          ...data.agents.map((a) => ({ id: a.id, label: a.name })),
        ].map((item) => (
          <MenuItem
            selected={filter === item.id}
            key={item.id}
            onClick={() => {
              setFilter(item.id)
              setFilterAnchor(null)
            }}
          >
            {item.label}
          </MenuItem>
        ))}
      </Menu>
      <Menu anchorEl={taskMenu?.el} open={!!taskMenu} onClose={() => setTaskMenu(null)}>
        <MenuItem
          disabled={!taskMenu || !!taskMenu.task.queue || taskHasActiveAgent(taskMenu.task)}
          onClick={() => {
            if (taskMenu) {
              const group = tasks.filter((t) => t.status === taskMenu.task.status)
              const index = group.findIndex((t) => t.id === taskMenu.task.id)
              if (index > 0)
                void moveTask(taskMenu.task.id, taskMenu.task.status, group[index - 1].id)
            }
            setTaskMenu(null)
          }}
        >
          上移任务
        </MenuItem>
        <MenuItem
          disabled={!taskMenu || !!taskMenu.task.queue || taskHasActiveAgent(taskMenu.task)}
          onClick={() => {
            if (taskMenu) {
              const group = tasks.filter((t) => t.status === taskMenu.task.status)
              const index = group.findIndex((t) => t.id === taskMenu.task.id)
              if (index < group.length - 1)
                void moveTask(taskMenu.task.id, taskMenu.task.status, group[index + 2]?.id)
            }
            setTaskMenu(null)
          }}
        >
          下移任务
        </MenuItem>
        {(Object.keys(statusLabels) as TaskStatus[]).map((status) => (
          <MenuItem
            key={status}
            disabled={
              !!taskMenu &&
              (taskHasActiveAgent(taskMenu.task) || (!!taskMenu.task.queue && status === 'done'))
            }
            onClick={() => {
              if (taskMenu) void moveTask(taskMenu.task.id, status)
              setTaskMenu(null)
            }}
          >
            移至{statusLabels[status]}
          </MenuItem>
        ))}
        {taskMenu?.task.queue && (
          <MenuItem
            disabled={taskHasActiveAgent(
              tasks.find((task) => task.id === taskMenu.task.id) ?? taskMenu.task,
            )}
            onClick={() => {
              void reinService
                .deleteTask(taskMenu.task.id)
                .then(() => notify('任务已删除，Spec 文档和执行历史已保留。'))
                .catch((error) => notify(error instanceof Error ? error.message : '删除失败'))
              setTaskMenu(null)
            }}
          >
            删除任务
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            if (taskMenu) onTask(taskMenu.task.id)
            setTaskMenu(null)
          }}
        >
          查看任务详情
        </MenuItem>
      </Menu>
    </section>
  )
}
