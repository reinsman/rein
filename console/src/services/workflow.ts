import { request, toUpdate } from './localService'
import type { RunUpdate } from './localService'

export type QueueRole = 'coding' | 'review'
export type SpecKind = 'feature' | 'bugfix'
export interface WorkflowSettings {
  main_agent: string | null
  coding_agents: string[]
  review_agents: string[]
  automatic: boolean
}
export interface PlanCriterion {
  id: string
  text: string
}
export interface PlanTask {
  id: string
  title: string
  description: string
  acceptance_ids: string[]
}
export interface Spec {
  id: string
  project_id: string
  requirement_id: string
  title: string
  description: string
  kind: SpecKind
  directory: string
  phase:
    | 'requirements'
    | 'design'
    | 'tasks'
    | 'building'
    | 'ready_verification'
    | 'verifying'
    | 'repairing'
    | 'ready_complete'
    | 'complete'
  paused: boolean
  round: number
  session_id: string
  document_run_id?: string | null
  agent_id: string | null
  plan: { criteria: PlanCriterion[]; tasks: PlanTask[] }
  error: string | null
}
export interface Handoff {
  kind: string
  file: string
  agent_id: string
  run_id: string | null
}
export interface QueueTask {
  id: string
  requirement_id: string
  spec_id: string | null
  title: string
  description: string
  role: QueueRole
  status: 'todo' | 'running' | 'done'
  plan_id: string | null
  criterion_id: string | null
  round: number
  paused: boolean
  manual: boolean
  agent_id: string | null
  request_id: string | null
  run_id: string | null
  last_run_id?: string | null
  execution_state?: string | null
  attempt: number
  error: string | null
  result: {
    outcome: 'passed' | 'failed'
    summary: string
    evidence: string
    responsible_task_id: string | null
  } | null
  handoffs: Handoff[]
  directory: string
}
export interface WorkflowSnapshot {
  execution_states?: Record<string, string[]>
  execution_runs?: Record<string, { id: string; state: string; interaction_id?: string | null }[]>
  ready_spec_ids?: string[]
  settings: WorkflowSettings
  specs: Spec[]
  tasks: QueueTask[]
  conversations: Conversation[]
  messages?: TaskMessage[]
}
export interface TaskMessage {
  id: string
  requirement_id: string
  spec_id: string | null
  task_id: string
  run_id?: string | null
  agent_id: string
  kind: string
  content: string
  handoff?: string | null
  created_at: number
  update_error: string | null
}

export function taskMessagePreview(message: TaskMessage, workflow?: WorkflowSnapshot) {
  const task =
    message.kind === 'completed' && message.handoff
      ? workflow?.tasks.find((task) => task.id === message.task_id)
      : undefined
  const file = task?.handoffs.find(
    (handoff) =>
      handoff.file === message.handoff &&
      (!message.run_id || !handoff.run_id || handoff.run_id === message.run_id),
  )?.file
  if (!task || !file) return { content: message.content }
  const summary = Array.from(message.content.split('\n', 1)[0])
  const content = summary.length > 180 ? summary.slice(0, 180).join('') + '…' : summary.join('')
  return {
    content,
    preview: { task, file, report: content !== message.content ? message.content : undefined },
  }
}
export interface Conversation {
  id: string
  requirement_id: string
  agent_id: string
  session_id: string
}
export const planningConfirmations: Record<string, string> = {
  approve_requirements: '确认需求，继续设计',
  approve_design: '确认设计，拆分任务',
  build: '确认任务，开始构建',
}
export const workflowService = {
  conversation: (id: string) => request<Conversation>(`/api/requirements/${id}/conversation`),
  async requirementChat(id: string, prompt: string, request_id: string, session_id?: string) {
    const response = await request<{ run: Parameters<typeof toUpdate>[0]['run'] }>(
      `/api/requirements/${id}/chat`,
      { method: 'POST', body: JSON.stringify({ prompt, request_id, session_id }) },
    )
    return {
      run: toUpdate({
        run: response.run,
        agent_id: '',
        version: '0',
        prompt,
        created_at: '',
        events: [],
        command_acks: [],
      }).run,
    }
  },
  snapshot: (signal?: AbortSignal) => request<WorkflowSnapshot>('/api/workflow', { signal }),
  settings: (settings: WorkflowSettings) =>
    request<WorkflowSnapshot>('/api/workflow/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  createSpec: (requirement_id: string, title: string, description: string, kind: SpecKind) =>
    request<{ spec: Spec }>('/api/specs', {
      method: 'POST',
      body: JSON.stringify({ requirement_id, title, description, kind, start: true }),
    }),
  beginSpec: (id: string) => request(`/api/specs/${id}/start`, { method: 'POST' }),
  specAction: (id: string, action: string) =>
    request<WorkflowSnapshot>(`/api/specs/${id}/action`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  plan: (id: string) => request<Spec['plan']>(`/api/specs/${id}/plan`),
  submitTask: (id: string, plan_id: string) =>
    request(`/api/specs/${id}/tasks`, { method: 'POST', body: JSON.stringify({ plan_id }) }),
  retryTaskUpdate: (id: string) => request(`/api/task-messages/${id}/retry`, { method: 'POST' }),
  file: (id: string, name: string) =>
    request<{ content: string; confirmed: boolean }>(
      `/api/artifacts/${id}/${encodeURIComponent(name)}`,
    ),
  saveFile: (id: string, name: string, content: string, previous?: string) =>
    request(`/api/artifacts/${id}/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ content, previous }),
    }),
  createTask: (
    requirement_id: string,
    title: string,
    description = '',
    role: QueueRole = 'coding',
  ) =>
    request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ requirement_id, title, description, role }),
    }),
  deleteTask: (id: string) => request<WorkflowSnapshot>(`/api/tasks/${id}`, { method: 'DELETE' }),
  taskAction: (
    id: string,
    action: string,
    patch: { description?: string; agent_id?: string } = {},
  ) =>
    request<WorkflowSnapshot>(`/api/tasks/${id}/action`, {
      method: 'POST',
      body: JSON.stringify({ action, ...patch }),
    }),
  async chat(
    id: string,
    prompt: string,
    request_id: string,
    options?: { edited_document?: string; next_document?: 'modify' | 'keep' },
    session_id?: string,
  ) {
    const response = await request<{ run: Parameters<typeof toUpdate>[0]['run'] }>(
      `/api/specs/${id}/chat`,
      { method: 'POST', body: JSON.stringify({ prompt, request_id, options, session_id }) },
    )
    return {
      run: toUpdate({
        run: response.run,
        agent_id: '',
        version: '0',
        prompt,
        created_at: '',
        events: [],
        command_acks: [],
      }).run,
    } as Pick<RunUpdate, 'run'>
  },
}
export const phaseLabels: Record<Spec['phase'], string> = {
  requirements: '需求',
  design: '设计',
  tasks: '任务',
  building: '构建中',
  ready_verification: '可提交验证',
  verifying: '验证中',
  repairing: '返修中',
  ready_complete: '验收可完成',
  complete: '已完成',
}
