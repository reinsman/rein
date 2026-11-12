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
import type { Project as StoredProject } from '../localTypes'
import { localService, request } from './localService'
import { createSpecPhases } from './spec'

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
  const previous = new Map(data.tasks.map((task) => [task.id, task]))
  data.tasks = values.flatMap((p) =>
    p.requirements.flatMap((r) =>
      r.tasks.map((t) => ({
        ...previous.get(t.id),
        id: t.id,
        displayId: `T-${t.id.slice(0, 8)}`,
        title: t.title,
        requirementId: r.id,
        agentId: previous.get(t.id)?.agentId ?? '',
        status: t.status,
        execution: t.status === 'done' ? ('completed' as const) : ('queued' as const),
        statusText: { todo: '待执行', running: '进行中', done: '已完成' }[t.status],
        description: previous.get(t.id)?.description ?? t.title,
        dependsOn: previous.get(t.id)?.dependsOn ?? [],
        specPhases: previous.get(t.id)?.specPhases ?? createSpecPhases(t.title, t.status),
      })),
    ),
  )
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
  refreshAgents,
  refreshProjects,
  async getData() {
    await Promise.all([refreshAgents(), refreshProjects()])
    return clone()
  },
  subscribe(fn: (value: AppData) => void) {
    subscribers.add(fn)
    const timer = window.setInterval(() => void refreshAgents(), 2000)
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
  async sendMessage(_scopeId: string, _content: string) {
    throw new Error('需求对话尚未连接执行服务，请从左侧选择 Agent 开始对话。')
  },
  async updateTask(id: string, patch: Partial<Pick<Task, 'status' | 'execution' | 'statusText'>>) {
    const task = data.tasks.find((t) => t.id === id)
    if (!task) throw new Error('任务不存在。')
    await this.moveTask(id, patch.status ?? task.status)
  },
  async moveTask(id: string, status: TaskStatus, beforeId?: string) {
    if (beforeId === id) return
    const task = data.tasks.find((t) => t.id === id)
    if (!task) throw new Error('任务不存在。')
    if (taskHasActiveAgent(task)) throw new Error('Agent 会话仍在运行，请先停止任务再移动。')
    const previous = projects.find((p) => p.requirements.some((r) => r.id === task.requirementId))
    if (!previous) throw new Error('所属项目不存在。')
    const next = structuredClone(previous)
    const requirement = next.requirements.find((r) => r.id === task.requirementId)!
    const value = requirement.tasks.find((t) => t.id === id)!
    value.status = status
    requirement.tasks = requirement.tasks.filter((t) => t.id !== id)
    if (beforeId) {
      const target = requirement.tasks.findIndex((t) => t.id === beforeId && t.status === status)
      if (target < 0) throw new Error('目标位置已变化，请重试。')
      requirement.tasks.splice(target, 0, value)
    } else {
      requirement.tasks.push(value)
    }
    await saveProjectFile(next, previous)
  },
  async command(_taskId: string, _agentId: string, _command: string) {
    throw new Error('任务终端尚未连接，请在 Agent 对话中发送消息。')
  },
  async createTask(requirementId: string, title: string, status: TaskStatus) {
    const previous = projects.find((p) => p.requirements.some((r) => r.id === requirementId))
    if (!previous) throw new Error('请先选择或创建需求。')
    if (!title.trim()) throw new Error('请输入任务名称。')
    const next = structuredClone(previous)
    next.requirements
      .find((r) => r.id === requirementId)!
      .tasks.push({ id: crypto.randomUUID(), title: title.trim(), status })
    await saveProjectFile(next, previous)
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
