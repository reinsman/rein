import type {
  Agent,
  AgentConfiguration,
  AppData,
  ChatScope,
  Project,
  Requirement,
  Task,
  TaskStatus,
} from '../types'
import type { Project as StoredProject, Task as StoredTask } from '../localTypes'
import { localService, request } from './localService'
import { blockedReason, completionError, taskNumber, taskTypes } from './sdd'
import { workflowService, type QueueRole } from './workflow'

let data: AppData = {
  projects: [],
  requirements: [],
  agents: [],
  tasks: [],
  messages: [],
  sessions: [],
  agentLoading: true,
}
let projects: StoredProject[] = []
let refresh: Promise<void> | undefined
let projectRefresh: Promise<void> | undefined
const subscribers = new Set<(data: AppData) => void>()
const clone = () => structuredClone(data)
function publish() {
  for (const subscriber of subscribers) subscriber(clone())
}
function applyProjects(values: StoredProject[]) {
  projects = values
  data.projects = values.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    directories: p.directories ?? [],
    preferred_directory: p.preferred_directory ?? p.directories?.[0] ?? null,
    requirementIds: p.requirements.map((r) => r.id),
  }))
  data.requirements = values.flatMap((p) =>
    p.requirements.map((r) => ({
      id: r.id,
      projectId: p.id,
      title: r.title,
      description: r.description,
    })),
  )
  data.tasks = values.flatMap((p) =>
    p.requirements.flatMap((r) =>
      r.tasks.map((t) => ({
        ...t,
        id: t.id,
        displayId: taskNumber(t),
        title: t.title,
        requirementId: r.id,
        agentId: t.agent_id ?? '',
        status: t.status,
        execution: t.status === 'done' ? ('completed' as const) : ('queued' as const),
        statusText: { todo: '待执行', running: '进行中', done: '已完成' }[t.status],
        description: t.description ?? '',
        dependsOn: t.depends_on ?? [],
      })),
    ),
  )
  for (const queue of data.workflow?.tasks ?? []) {
    const roleAgents =
      (queue.role === 'coding'
        ? data.workflow?.settings.coding_agents
        : data.workflow?.settings.review_agents) ?? []
    const waiting =
      roleAgents.length === 0
        ? `未配置 ${queue.role === 'coding' ? 'Coding' : 'Review'} Agent`
        : !roleAgents.some((id) => data.agents.some((agent) => agent.id === id && agent.online))
          ? '等待对应 Agent 上线'
          : !data.workflow?.settings.automatic && !queue.manual
            ? '等待手动开始'
            : '待领取'
    data.tasks = data.tasks.filter((task) => task.id !== queue.id)
    data.tasks.push({
      id: queue.id,
      title: queue.title,
      status: queue.status,
      description: queue.description,
      agent_id: queue.agent_id ?? '',
      agentId: queue.agent_id ?? '',
      requirementId: queue.requirement_id,
      dependsOn: [],
      displayId: `T-${queue.id.slice(0, 6)}`,
      execution:
        queue.status === 'running'
          ? ['waiting_input', 'waiting_approval'].includes(queue.execution_state ?? '')
            ? 'waiting'
            : 'executing'
          : queue.status === 'done'
            ? 'completed'
            : 'queued',
      statusText: queue.error
        ? '执行需处理'
        : queue.paused
          ? '已暂停'
          : queue.status === 'running'
            ? queue.execution_state === 'waiting_approval'
              ? '等待审批'
              : queue.execution_state === 'waiting_input'
                ? '等待输入'
                : '执行中'
            : queue.status === 'done'
              ? queue.result?.outcome === 'failed'
                ? '验收未通过'
                : '已完成'
              : waiting,
      queue,
    })
  }
}
async function refreshWorkflow() {
  try {
    data.workflow = await workflowService.snapshot()
    data.workflowError = undefined
    applyProjects(projects)
  } catch (error) {
    data.workflowError = error instanceof Error ? error.message : '无法读取工作流'
  }
  publish()
}
async function refreshAgents() {
  if (refresh) return refresh
  refresh = (async () => {
    try {
      data.agents = await localService.agents()
      data.agentError = undefined
    } catch (error) {
      data.agentError = error instanceof Error ? error.message : '无法连接 reind'
      data.agents = data.agents.map((agent) => ({ ...agent, online: false }))
    } finally {
      data.agentLoading = false
      publish()
    }
  })()
  try {
    await refresh
  } finally {
    refresh = undefined
  }
}
async function refreshProjects() {
  if (projectRefresh) return projectRefresh
  projectRefresh = (async () => {
    try {
      applyProjects(await localService.projects())
      data.projectError = undefined
    } catch (error) {
      data.projectError = error instanceof Error ? error.message : '无法读取项目'
    } finally {
      publish()
    }
  })()
  try {
    await projectRefresh
  } finally {
    projectRefresh = undefined
  }
}
async function saveProjectFile(next: StoredProject, previous: StoredProject | null) {
  const saved = await localService.saveProject(next, previous)
  applyProjects([...projects.filter((p) => p.id !== saved.id), saved])
  publish()
  return saved
}
export function taskHasActiveAgent(task: Task) {
  return task.execution === 'executing' || task.execution === 'waiting'
}
export const reinService = {
  refreshWorkflow,
  refreshAgents,
  refreshProjects,
  async getData() {
    await Promise.all([refreshAgents(), refreshProjects(), refreshWorkflow()])
    return clone()
  },
  subscribe(fn: (value: AppData) => void) {
    subscribers.add(fn)
    const timer = window.setInterval(() => {
      void refreshAgents()
      void refreshWorkflow()
    }, 2000)
    return () => {
      window.clearInterval(timer)
      subscribers.delete(fn)
    }
  },
  async login(email: string, password: string) {
    if (!email.includes('@') || password.length < 4)
      throw new Error('请输入有效邮箱和至少 4 位演示密码。')
    return { name: 'Haibin', mode: 'demo' as const }
  },
  async sendMessage(scopeId: string, content: string) {
    const requirement = data.requirements.find((r) => r.id === scopeId)
    if (!requirement) throw new Error('请选择需求。')
    const task = content.match(/^(?:请)?(?:添加|新建)(?:一个)?任务[：:\s]*([\s\S]+)/)
    if (task) {
      await workflowService.createTask(scopeId, task[1].trim().slice(0, 80), content)
      await refreshWorkflow()
    } else if (!data.workflow?.settings.main_agent)
      throw new Error('请在系统配置中设置主 Agent，或使用“添加任务：任务内容”。')
    else throw new Error('需求页可用“添加任务：任务内容”创建任务；Spec 技术讨论请进入对应 Spec。')
    data.messages.push({
      id: crypto.randomUUID(),
      scopeId,
      authorId: 'user',
      time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      content,
    })
    publish()
  },
  async updateTask(id: string, patch: Partial<Pick<Task, 'status' | 'execution' | 'statusText'>>) {
    const task = data.tasks.find((t) => t.id === id)
    if (!task) throw new Error('任务不存在。')
    await this.moveTask(id, patch.status ?? task.status)
  },
  async saveTask(id: string, patch: Partial<StoredTask>, action = '保存草稿', beforeId?: string) {
    const task = data.tasks.find((value) => value.id === id)
    if (!task) throw new Error('任务不存在。')
    if (task.queue) {
      if (patch.status === 'done')
        throw new Error('任务完成由 Agent 结果与 handoff 确认，不能手动跳过执行。')
      await workflowService.taskAction(
        id,
        patch.status === 'running' ? 'start' : patch.status === 'todo' ? 'stop' : 'save',
        { description: patch.description, agent_id: patch.agent_id },
      )
      await refreshWorkflow()
      return structuredClone(data.tasks.find((t) => t.id === id)!)
    }
    if (taskHasActiveAgent(task)) throw new Error('Agent 会话仍在运行，请先停止任务再修改。')
    const previous = projects.find((p) => p.requirements.some((r) => r.id === task.requirementId))
    if (!previous) throw new Error('所属项目不存在。')
    const next = structuredClone(previous)
    const requirement = next.requirements.find((r) => r.id === task.requirementId)!
    const value = requirement.tasks.find((item) => item.id === id)!
    const oldStatus = value.status
    Object.assign(value, patch)
    if (value.status !== 'todo') {
      const reason = blockedReason(value, requirement.tasks)
      if (reason) throw new Error(reason)
    }
    if (value.status === 'done' && oldStatus !== 'done') {
      const reason = completionError({ ...value, status: oldStatus }, requirement.tasks)
      if (reason) throw new Error(reason)
    }
    const log = (item: StoredTask, message: string) => {
      // shortcut: keep the latest 200 actions here; use SQLite when a complete audit trail is needed.
      item.history = [...(item.history ?? []).slice(-199), { at: Date.now(), message }]
    }
    if (value.type && oldStatus === 'done' && value.status !== 'done') {
      const index = taskTypes.indexOf(value.type)
      for (const dependent of requirement.tasks) {
        if (dependent.type && taskTypes.indexOf(dependent.type) > index) {
          dependent.status = 'todo'
          if (dependent.type === 'verification')
            dependent.checks = dependent.checks?.map((check) => ({ ...check, status: 'pending' }))
          log(dependent, `前置任务 ${taskNumber(value)} 重新打开，需要复核`)
        }
      }
    }
    if (value.type === 'spec' && patch.criteria) {
      const verification = requirement.tasks.find((item) => item.type === 'verification')
      if (verification && JSON.stringify(patch.criteria) !== JSON.stringify(task.criteria ?? []))
        verification.checks = verification.checks
          ?.filter((check) =>
            patch.criteria!.some((criterion) => criterion.id === check.criterion_id),
          )
          .map((check) => ({ ...check, status: 'pending' }))
    }
    if (value.type === 'verification' && value.status === 'running') {
      if (oldStatus === 'done')
        value.checks = value.checks?.map((check) => ({ ...check, status: 'pending' }))
      const criteria = requirement.tasks.find((item) => item.type === 'spec')?.criteria ?? []
      value.checks = criteria.map(
        (criterion) =>
          value.checks?.find((check) => check.criterion_id === criterion.id) ?? {
            criterion_id: criterion.id,
            status: 'pending',
            evidence: '',
          },
      )
    }
    log(value, action)
    if (patch.status !== undefined && beforeId !== id) {
      requirement.tasks = requirement.tasks.filter((item) => item.id !== id)
      if (beforeId) {
        const index = requirement.tasks.findIndex(
          (item) => item.id === beforeId && item.status === value.status,
        )
        if (index < 0) throw new Error('目标位置已变化，请重试。')
        requirement.tasks.splice(index, 0, value)
      } else requirement.tasks.push(value)
    }
    await saveProjectFile(next, previous)
    return structuredClone(data.tasks.find((item) => item.id === id)!)
  },
  async moveTask(id: string, status: TaskStatus, beforeId?: string) {
    if (id === beforeId) return
    return this.saveTask(
      id,
      { status },
      { todo: '移至待开始', running: '开始任务', done: '确认完成任务' }[status],
      beforeId,
    )
  },
  async command(_taskId: string, _agentId: string, _command: string) {
    throw new Error('任务终端尚未连接，请在 Agent 对话中发送消息。')
  },
  async createTask(requirementId: string, title: string, role: QueueRole = 'coding') {
    const previous = projects.find((p) => p.requirements.some((r) => r.id === requirementId))
    if (!previous) throw new Error('请先选择或创建需求。')
    if (!title.trim()) throw new Error('请输入任务名称。')
    await workflowService.createTask(requirementId, title, '', role)
    await refreshWorkflow()
  },
  async saveProject(input: {
    id?: string
    name: string
    description: string
    directories: string[]
    preferred_directory: string | null
  }): Promise<Project> {
    const previous = input.id ? projects.find((p) => p.id === input.id) : null
    if (input.id && !previous) throw new Error('项目不存在，请重新选择。')
    const next = {
      ...previous,
      id: input.id ?? crypto.randomUUID(),
      name: input.name.trim(),
      description: input.description.trim(),
      directories: input.directories.map((directory) => directory.trim()),
      preferred_directory: input.preferred_directory?.trim() ?? null,
      requirements: previous?.requirements ?? [],
    }
    await saveProjectFile(next, previous ?? null)
    if (projectRefresh) await projectRefresh
    await refreshProjects()
    return structuredClone(data.projects.find((p) => p.id === next.id)!)
  },
  async saveRequirement(
    projectId: string,
    input: { id?: string; name: string; description: string },
  ): Promise<Requirement> {
    const previous = projects.find((p) => p.id === projectId)
    if (!previous) throw new Error('请选择所属项目。')
    if (!input.name.trim()) throw new Error('请输入需求名称。')
    if (previous.requirements.some((r) => r.id !== input.id && r.title === input.name.trim()))
      throw new Error('此项目已有同名需求。')
    const next = structuredClone(previous)
    const existing = input.id ? next.requirements.find((r) => r.id === input.id) : undefined
    if (input.id && !existing) throw new Error('需求不存在，请重新选择。')
    const id = input.id ?? crypto.randomUUID()
    const value = {
      id,
      title: input.name.trim(),
      description: input.description.trim(),
      tasks: existing?.tasks ?? [],
    }
    if (existing) next.requirements = next.requirements.map((r) => (r.id === id ? value : r))
    else next.requirements.push(value)
    await saveProjectFile(next, previous)
    return structuredClone(data.requirements.find((r) => r.id === id)!)
  },
  async saveAgent(value: AgentConfiguration, id?: string): Promise<Agent> {
    if (id) throw new Error('请编辑 ~/.reind/agents 下的 Agent 配置文件。')
    if (!['pi', 'codex'].includes(value.basic.provider)) throw new Error('请选择 Pi 或 Codex。')
    await request('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: value.basic.name.trim(),
        provider: value.basic.provider,
        enabled: false,
        a2a: value.a2a.enabled ? { url: value.a2a.endpoint.trim() } : null,
        ...(!value.a2a.enabled
          ? {
              directory: value.local.workingDirectory.trim(),
              executable: value.local.executable.trim() || null,
              model:
                value.local.model === '跟随 CLI 配置' ? null : value.local.model.trim() || null,
            }
          : {}),
      }),
    })
    if (refresh) await refresh
    await refreshAgents()
    const saved = data.agents.find((a) => a.name === value.basic.name.trim())
    if (!saved) throw new Error('Agent 已创建，但列表刷新失败，请重试。')
    return structuredClone(saved)
  },
  async exportData() {
    return JSON.stringify({ mode: 'local', ...data }, null, 2)
  },
  async reset() {
    await refreshAgents()
  },
}
export const defaultScope: ChatScope = { id: 'overview', title: '选择需求或 Agent', label: '项目' }
export function tasksInScope(data: AppData, scope: ChatScope) {
  return data.tasks.filter(
    (t) =>
      (!scope.requirementId || t.requirementId === scope.requirementId) &&
      (!scope.projectId ||
        data.requirements.find((r) => r.id === t.requirementId)?.projectId === scope.projectId) &&
      (!scope.status || t.status === scope.status),
  )
}
