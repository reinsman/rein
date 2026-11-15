import type { Task, TaskType } from '../localTypes'

// Legacy stage cards remain editable; new Specs use the workflow runtime.
export const taskTypes: TaskType[] = ['spec', 'design', 'tasks', 'verification']
export const taskTypeInfo: Record<
  TaskType,
  { label: string; title: string; icon: string; tab: string; file?: string }
> = {
  spec: {
    label: 'Spec',
    title: '需求规格与验收标准',
    icon: 'doc',
    tab: '需求规格',
    file: 'spec.md',
  },
  design: {
    label: 'Design',
    title: '技术设计与约束',
    icon: 'layers',
    tab: '设计文档',
    file: 'design.md',
  },
  tasks: { label: 'Tasks', title: '开发实现', icon: 'checklist', tab: '开发子任务' },
  verification: { label: '验证', title: '验证与验收', icon: 'shield', tab: '验收结果' },
}
export const taskNumber = (task: Task) =>
  task.type ? `T-0${taskTypes.indexOf(task.type) + 1}` : `T-${task.id.slice(0, 8)}`

export function predecessors(task: Task, tasks: Task[]) {
  return (task.depends_on ?? [])
    .map((id) => tasks.find((value) => value.id === id))
    .filter((value): value is Task => !!value)
}
export function blockedReason(task: Task, tasks: Task[]) {
  const pending = predecessors(task, tasks).filter((value) => value.status !== 'done')
  return pending.length
    ? `等待 ${pending.map((value) => `${taskNumber(value)} ${value.type ? taskTypeInfo[value.type].label : value.title}`).join('、')} 完成`
    : ''
}
export function completionError(task: Task, tasks: Task[]): string {
  const blocked = blockedReason(task, tasks)
  if (blocked) return blocked
  if (!task.type) return ''
  if (task.status === 'todo') return '请先开始任务，再确认完成。'
  if (task.type === 'spec') {
    if (!task.document?.trim()) return '请先填写需求规格。'
    if (!task.criteria?.length || task.criteria.some((item) => !item.text.trim()))
      return '请至少填写一条完整的验收标准。'
  }
  if (task.type === 'design' && !task.document?.trim()) return '请先填写技术设计。'
  if (
    task.type === 'tasks' &&
    (!task.subtasks?.length || task.subtasks.some((item) => !item.completed || !item.title.trim()))
  )
    return '请先完成全部开发子任务。'
  if (task.type === 'verification') {
    const criteria = tasks.find((value) => value.type === 'spec')?.criteria ?? []
    if (
      !criteria.length ||
      criteria.some(
        (criterion) =>
          !task.checks?.some(
            (check) =>
              check.criterion_id === criterion.id &&
              check.status === 'passed' &&
              check.evidence.trim(),
          ),
      )
    )
      return '每条验收标准都需要通过结果及验证证据。'
  }
  return ''
}
export function taskProgress(task: Task, tasks: Task[]): string {
  switch (task.type) {
    case 'spec':
      return `${task.criteria?.length ?? 0} 条验收标准${task.status === 'done' ? ' · 已确认' : ''}`
    case 'design':
      return task.status === 'done'
        ? '技术设计已确认'
        : task.document?.trim()
          ? '设计草稿待确认'
          : '明确实现边界与技术约束'
    case 'tasks':
      return `开发子任务 ${task.subtasks?.filter((item) => item.completed).length ?? 0} / ${task.subtasks?.length ?? 0}`
    case 'verification':
      return `验收通过 ${task.checks?.filter((check) => check.status === 'passed').length ?? 0} / ${tasks.find((value) => value.type === 'spec')?.criteria?.length ?? 0}`
    default:
      return task.description ?? ''
  }
}

export type TaskDraft = Pick<
  Required<Task>,
  'description' | 'agent_id' | 'document' | 'criteria' | 'subtasks' | 'checks'
>
export function taskDraft(task?: Task): TaskDraft {
  return structuredClone({
    description: task?.description ?? '',
    agent_id: task?.agent_id ?? '',
    document: task?.document ?? '',
    criteria: task?.criteria ?? [],
    subtasks: task?.subtasks ?? [],
    checks: task?.checks ?? [],
  })
}
