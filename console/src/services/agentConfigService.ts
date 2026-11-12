import type { Agent, AgentConfiguration } from '../types'

// Mock adapter: configuration is isolated per Agent and never touches CLI, disk or network.
const configurations = new Map<string, AgentConfiguration>()
function defaults(agent?: Agent): AgentConfiguration {
  return {
    basic: {
      name: agent?.name ?? '',
      description: agent?.description ?? '',
      provider: agent?.provider ?? 'codex',
    },
    a2a: {
      enabled: !!agent?.a2a,
      endpoint: `http://127.0.0.1:${agent?.id === 'alex' ? 8080 : agent?.id === 'sam' ? 8081 : 8082}/a2a`,
      cardPath: '/.well-known/agent-card.json',
      transport: 'JSON-RPC',
      timeout: 60,
      streaming: true,
    },
    local: {
      executable: agent?.provider ?? 'codex',
      workingDirectory: agent?.directory ?? '',
      model: '跟随 CLI 配置',
      approval: '每次确认',
      timeout: 300,
    },
    skills: {
      directories: './.agents/skills; ~/.agents/skills',
      enabled: 'code-review, testing',
      autoDiscover: true,
      allowCommands: true,
    },
    memory: {
      backend: '本地文件',
      directory: `~/.reind/memory/${agent?.id ?? 'new-agent'}`,
      namespace: 'agent-default',
      retentionDays: 30,
      autoSave: true,
    },
  }
}
export const agentConfigService = {
  async get(agent?: Agent): Promise<AgentConfiguration> {
    return structuredClone((agent && configurations.get(agent.id)) || defaults(agent))
  },
  async save(agentId: string, value: AgentConfiguration) {
    const next = structuredClone(value)
    next.basic.name = next.basic.name.trim()
    next.basic.description = next.basic.description.trim()
    if (!next.basic.name || next.basic.name.length > 80)
      throw new Error('请填写 1–80 个字符的 Agent 名称。')
    if (next.basic.description.length > 1000) throw new Error('Agent 描述不能超过 1000 个字符。')
    if (!['claude', 'codex', 'pi'].includes(next.basic.provider))
      throw new Error('请选择 Claude、Codex 或 pi。')
    let endpoint: URL
    try {
      endpoint = new URL(next.a2a.endpoint)
    } catch {
      throw new Error('服务地址无效，请输入完整的 http:// 或 https:// 地址。')
    }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)
      throw new Error('服务地址必须使用 HTTP 或 HTTPS，且不能包含凭据。')
    if (!next.a2a.cardPath.trim().startsWith('/')) throw new Error('Agent Card 路径应以 / 开头。')
    for (const [label, number] of [
      ['请求超时', next.a2a.timeout],
      ['执行超时', next.local.timeout],
      ['保留天数', next.memory.retentionDays],
    ] as const)
      if (!Number.isInteger(number) || number < 1 || number > 86400)
        throw new Error(`${label}应为 1–86400 之间的整数。`)
    for (const [label, value] of [
      ['可执行文件', next.local.executable],
      ['工作目录', next.local.workingDirectory],
      ['默认模型', next.local.model],
      ['技能目录', next.skills.directories],
      ['存储目录', next.memory.directory],
      ['命名空间', next.memory.namespace],
    ])
      if (!value.trim()) throw new Error(`请填写${label}。`)
    configurations.set(agentId, next)
    return structuredClone(next)
  },
  reset() {
    configurations.clear()
  },
}
