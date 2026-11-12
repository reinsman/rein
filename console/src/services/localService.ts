import type { Agent } from '../types'
import type { AgentConfig, Project } from '../localTypes'
export type { Agent } from '../types'

export type AgentRun = {
  id: string
  attemptId: string
  sessionId: string
  agentId: string
  state: string
  cancelRequested: boolean
  finishedAt?: number | null
}
export type AgentEvent = {
  attempt: { runId: string; attemptId: string }
  sequence: string
  state?: { state: string }
  text?: { itemId: string; text: string; complete: boolean; reasoning: boolean }
  tool?: {
    callId: string
    name: string
    inputJson: string
    outputJson: string
    complete: boolean
    isError: boolean
  }
  interaction?: {
    interactionId: string
    approvalRequired: boolean
    method: string
    parametersJson: string
  }
  error?: { code: string; message: string }
  result?: { state: string; executionStopped: boolean }
}
export type RunRecord = {
  version: string
  run: AgentRun
  prompt: string
  created_at: string
  command_acks?: { commandId: string; state: string; errorCode: string }[]
}
export type RunUpdate = RunRecord & { events: AgentEvent[] }
export type HistoryPage = {
  runs: RunUpdate[]
  sessions: { id: string; prompt: string }[]
  session_id: string
  next_cursor: string
  stream_cursor: string
}

interface LocalRun {
  run_id: string
  attempt_id: string
  session_id: string
  state: string
  cancel_requested: boolean
  last_sequence: number
  finished_at?: number | null
  error?: string
}
interface LocalRecord {
  run: LocalRun
  agent_id: string
  prompt: string
  created_at: string
  version: string
  events: { sequence: number; event: Record<string, unknown> }[]
  command_acks: RunRecord['command_acks']
}
const stateName = (state: string) => `RUN_STATE_${state.toUpperCase()}`
function toRun(run: LocalRun, agentId: string): AgentRun {
  return {
    id: run.run_id,
    attemptId: run.attempt_id,
    sessionId: run.session_id,
    agentId,
    state: stateName(run.state),
    cancelRequested: run.cancel_requested,
    finishedAt: run.finished_at,
  }
}
const encode = (value: unknown) =>
  value == null
    ? ''
    : btoa(
        Array.from(new TextEncoder().encode(JSON.stringify(value)), (c) =>
          String.fromCharCode(c),
        ).join(''),
      )
export function toUpdate(record: LocalRecord): RunUpdate {
  const run = toRun(record.run, record.agent_id)
  const events = record.events.map(({ sequence, event: item }) => {
    const event: AgentEvent = {
      attempt: { runId: run.id, attemptId: run.attemptId },
      sequence: String(sequence),
    }
    switch (item.type) {
      case 'text':
        event.text = {
          itemId: String(item.item_id),
          text: String(item.text),
          complete: !!item.complete,
          reasoning: !!item.reasoning,
        }
        break
      case 'tool':
        event.tool = {
          callId: String(item.call_id),
          name: String(item.name),
          inputJson: encode(item.input),
          outputJson: encode(item.output),
          complete: !!item.complete,
          isError: !!item.is_error,
        }
        break
      case 'interaction':
        event.interaction = {
          interactionId: String(item.interaction_id),
          method: String(item.method),
          approvalRequired: !!item.approval_required,
          parametersJson: encode(item.parameters),
        }
        break
      case 'error':
        event.error = { code: String(item.code), message: String(item.message) }
        break
    }
    return event
  })
  if (record.run.error && !events.some((e) => e.error?.message === record.run.error))
    events.push({
      attempt: { runId: run.id, attemptId: run.attemptId },
      sequence: '0',
      error: { code: 'execution', message: record.run.error },
    })
  return { ...record, run, events }
}
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30000),
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  const body = await response.json().catch(() => ({ error: 'reind 返回了无效响应。' }))
  if (!response.ok) throw new Error(body.error || `请求失败 (${response.status})`)
  return body as T
}
export const localService = {
  async agents(): Promise<Agent[]> {
    const { agents } = await request<{ agents: AgentConfig[] }>('/api/agents')
    return agents.map((a) => ({
      ...a,
      role: '',
      color: '#0866ff',
      hubManaged: true,
      id: a.name,
      online: a.enabled,
      disabled: !a.enabled,
      cli: a.provider === 'pi' ? 'Pi' : 'Codex',
      backend: a.a2a ? 'a2a' : 'native',
    }))
  },
  async history(
    agent: string,
    session: string,
    before: string,
    signal: AbortSignal,
  ): Promise<HistoryPage> {
    const query = new URLSearchParams({ session_id: session, before })
    const page = await request<Omit<HistoryPage, 'runs'> & { runs: LocalRecord[] }>(
      `/api/agents/${encodeURIComponent(agent)}/history?${query}`,
      { signal },
    )
    return { ...page, runs: page.runs.map(toUpdate) }
  },
  stream(agent: string, _cursor: string) {
    return new EventSource(`/api/agents/${encodeURIComponent(agent)}/events`)
  },
  async create(agent_id: string, session_id: string, prompt: string, request_id: string) {
    const { run } = await request<{ run: LocalRun }>('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ agent_id, session_id, prompt, request_id }),
    })
    return { run: toRun(run, agent_id) }
  },
  cancel(run: AgentRun, command_id: string) {
    return request(`/api/runs/${run.id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ attempt_id: run.attemptId, command_id }),
    })
  },
  reply(run: AgentRun, interaction_id: string, response: unknown, command_id: string) {
    return request(`/api/runs/${run.id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ attempt_id: run.attemptId, command_id, interaction_id, response }),
    })
  },
  async projects() {
    return (await request<{ projects: Project[] }>('/api/projects')).projects
  },
  async saveProject(project: Project, previous: Project | null) {
    return (
      await request<{ project: Project }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ project, previous }),
      })
    ).project
  },
}
export function decodeJson<T = Record<string, unknown>>(value: string): T {
  if (!value) return {} as T
  return JSON.parse(
    new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0))),
  ) as T
}
export const terminalRun = (run: AgentRun) =>
  ['RUN_STATE_COMPLETED', 'RUN_STATE_FAILED', 'RUN_STATE_CANCELLED'].includes(run.state)
export const runStateLabel: Record<string, string> = {
  RUN_STATE_QUEUED: '排队中',
  RUN_STATE_DISPATCHED: '准备执行',
  RUN_STATE_RUNNING: '执行中',
  RUN_STATE_WAITING_INPUT: '等待回复',
  RUN_STATE_WAITING_APPROVAL: '等待审批',
  RUN_STATE_COMPLETED: '已完成',
  RUN_STATE_FAILED: '执行失败',
  RUN_STATE_CANCELLED: '已取消',
}
