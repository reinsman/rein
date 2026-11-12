import { useRef, useState } from 'react'
import { ButtonBase, Menu, MenuItem, Paper } from '@mui/material'
import type { AppData, ChatScope, Task, TaskStatus } from '../types'
import { reinService, taskHasActiveAgent, tasksInScope } from '../services/reinService'
import { Action, AgentAvatar, Icon, StateIcon, StatusDot } from './shared'
import { statusLabels } from '../constants'
import { TaskDependencies } from './TaskDependencies'

interface Props {
  data: AppData
  scope: ChatScope
  selectedId: string | null
  onTask: (id: string) => void
  onCreate: (status: TaskStatus) => void
  notify: (message: string) => void
}
export function TaskPanel({ data, scope, selectedId, onTask, onCreate, notify }: Props) {
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
        <Action
          label="任务栏设置"
          icon="settings"
          onClick={() => notify('任务栏设置功能待确定。')}
        />
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
                    return (
                      <Paper
                        data-task-id={task.id}
                        draggable={!taskHasActiveAgent(task)}
                        onDragStart={(event) => {
                          if (taskHasActiveAgent(task)) {
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
                        className={`task-card ${selectedId === task.id ? 'selected' : ''} ${task.execution === 'waiting' ? 'waiting-task' : ''} ${draggedId === task.id ? 'is-dragging' : ''} ${draggedId && dropTarget?.beforeId === task.id ? 'drop-before' : ''}`}
                        key={task.id}
                      >
                        <div className="task-card-meta">
                          <span
                            title={
                              taskHasActiveAgent(task)
                                ? 'Agent 会话占用中，请先停止任务再移动'
                                : '可拖拽调整顺序或移动到其他栏'
                            }
                          >
                            #{task.displayId ?? task.id}
                          </span>
                          {!!task.dependsOn?.length && (
                            <span
                              className="task-dependency-label"
                              title={`前置任务：${task.dependsOn.join('、')}`}
                            >
                              依赖 {task.dependsOn.join('、')}
                            </span>
                          )}
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
                          <div className="task-assignee">
                            <AgentAvatar agent={agent} size={18} />
                            <span>
                              {agent?.name}
                              {task.reviewerId
                                ? ` / ${data.agents.find((a) => a.id === task.reviewerId)?.name ?? '待分配'}`
                                : ` · ${agent?.role}`}
                            </span>
                          </div>
                          <div className={`task-state ${task.execution}`}>
                            <StateIcon state={task.execution} />
                            <span>{task.statusText}</span>
                          </div>
                        </ButtonBase>
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
          disabled={!taskMenu || taskHasActiveAgent(taskMenu.task)}
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
          disabled={!taskMenu || taskHasActiveAgent(taskMenu.task)}
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
            disabled={!!taskMenu && taskHasActiveAgent(taskMenu.task)}
            onClick={() => {
              if (taskMenu) void moveTask(taskMenu.task.id, status)
              setTaskMenu(null)
            }}
          >
            移至{statusLabels[status]}
          </MenuItem>
        ))}
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
