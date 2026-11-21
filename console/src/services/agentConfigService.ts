import type { AgentPermissions } from '../localTypes'
import type { Agent, AgentConfiguration } from '../types'
import { request } from './localService'

export type TypeDefaults = {
  model: string | null
  model_provider: string | null
  reasoning_effort: string | null
  permissions: AgentPermissions
}

export const codexPermissionModes = {
  workspace_write: '请求审批 Ask for approval',
  approve_for_me: '帮我审批 Approve for me',
  full_access: '完全访问 Full access',
}

export const permissionLabels: Record<AgentPermissions, string> = {
  ...codexPermissionModes,
  read_only: '只读（旧配置）',
}

export const codexPermissionDescriptions: Record<AgentPermissions, string> = {
  workspace_write: '使用工作区写入沙箱，需要额外权限时由你审批。',
  approve_for_me: '使用工作区写入沙箱，符合条件的请求由 Codex 自动审查。',
  full_access: '关闭 Codex 沙箱和操作审批，以启动账户的权限执行。',
  read_only: '使用只读沙箱，需要额外权限时由你审批。',
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
