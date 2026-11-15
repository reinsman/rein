import { request, toUpdate } from './localService'
import type { RunUpdate } from './localService'

export type QueueRole = 'coding' | 'review'
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
  settings: WorkflowSettings
  specs: Spec[]
  tasks: QueueTask[]
  conversations: Conversation[]
}
export interface Conversation {
  id: string
  requirement_id: string
  agent_id: string
  session_id: string
}
export const workflowService = {
  conversation: (id: string) => request<Conversation>(`/api/requirements/${id}/conversation`),
  async requirementChat(id: string, prompt: string, request_id: string) {
    const response = await request<{ run: Parameters<typeof toUpdate>[0]['run'] }>(
      `/api/requirements/${id}/chat`,
      { method: 'POST', body: JSON.stringify({ prompt, request_id }) },
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
  snapshot: () => request<WorkflowSnapshot>('/api/workflow'),
  settings: (settings: WorkflowSettings) =>
    request<WorkflowSnapshot>('/api/workflow/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  createSpec: (requirement_id: string, title: string, description: string) =>
    request<{ spec: Spec }>('/api/specs', {
      method: 'POST',
      body: JSON.stringify({ requirement_id, title, description }),
    }),
  specAction: (id: string, action: string) =>
    request<WorkflowSnapshot>(`/api/specs/${id}/action`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  file: (id: string, name: string) =>
    request<{ content: string }>(`/api/artifacts/${id}/${encodeURIComponent(name)}`),
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
  taskAction: (
    id: string,
    action: string,
    patch: { description?: string; agent_id?: string } = {},
  ) =>
    request<WorkflowSnapshot>(`/api/tasks/${id}/action`, {
      method: 'POST',
      body: JSON.stringify({ action, ...patch }),
    }),
  async chat(id: string, prompt: string, request_id: string) {
    const response = await request<{ run: Parameters<typeof toUpdate>[0]['run'] }>(
      `/api/specs/${id}/chat`,
      { method: 'POST', body: JSON.stringify({ prompt, request_id }) },
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
  requirements: '需求待确认',
  design: '设计待确认',
  tasks: '任务待确认',
  building: '构建中',
  ready_verification: '可提交验证',
  verifying: '验证中',
  repairing: '返修中',
  ready_complete: '验收可完成',
  complete: '已完成',
}
