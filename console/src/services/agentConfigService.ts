import type { AgentPermissions } from '../localTypes'
import type { Agent, AgentConfiguration } from '../types'
import { request } from './localService'

export type TypeDefaults = {
  model: string | null
  model_provider: string | null
  reasoning_effort: string | null
  permissions: AgentPermissions
}

export const permissionLabels: Record<AgentPermissions, string> = {
  full_access: 'Full access（YOLO）',
  workspace_write: '项目目录写入',
  read_only: '只读',
}

export const agentConfigService = {
  typeDefaults(provider: Agent['provider'], signal: AbortSignal) {
    return request<TypeDefaults>(`/api/agent-types/${provider}/defaults`, { signal })
  },
  modelName(defaults: TypeDefaults | null | undefined) {
    if (!defaults?.model) return '由原生 CLI 选择'
    return defaults.model_provider
      ? `${defaults.model} · ${defaults.model_provider}`
      : defaults.model
  },
  get(agent?: Agent): AgentConfiguration {
    return {
      name: agent?.name ?? '',
      provider: agent?.provider ?? 'codex',
      enabled: agent?.enabled ?? false,
      a2a: agent?.a2a ? { ...agent.a2a } : null,
      directory: agent?.directory ?? null,
      executable: agent?.executable ?? null,
      native_config: agent?.native_config ?? null,
      model: agent?.model ?? null,
      prepare: agent?.prepare ?? null,
      permissions: agent?.permissions ?? null,
      reasoning_effort: agent?.reasoning_effort ?? null,
      skill_directories: [...(agent?.skill_directories ?? [])],
      skill_source: agent?.skill_source ?? 'rein',
      disabled_skills: [...(agent?.disabled_skills ?? [])],
    }
  },
}
