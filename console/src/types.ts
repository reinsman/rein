export type TaskStatus = 'todo' | 'running' | 'done'
export type ExecutionState = 'queued' | 'executing' | 'waiting' | 'completed' | 'stopped'
export interface Project {
  id: string
  name: string
  directories: string[]
  preferred_directory: string | null
  description?: string
  requirementIds: string[]
}
export interface Requirement {
  id: string
  title: string
  description?: string
  projectId: string
}
import type { AgentConfig } from './localTypes'
export interface Agent extends AgentConfig {
  id: string
  name: string
  role: string
  color: string
  online: boolean
  cli: string
  provider: 'codex' | 'pi'
  disabled: boolean
  backend: 'native' | 'a2a'
  hubManaged?: boolean
  description?: string
}
export interface AgentConfiguration {
  basic: {
    name: string
    description: string
    provider: Agent['provider']
  }
  a2a: {
    enabled: boolean
    endpoint: string
    cardPath: string
    transport: 'JSON-RPC' | 'HTTP+JSON'
    timeout: number
    streaming: boolean
  }
  local: {
    executable: string
    workingDirectory: string
    model: string
    approval: '每次确认' | '项目目录写入' | '只读'
    timeout: number
  }
  skills: {
    directories: string
    enabled: string
    autoDiscover: boolean
    allowCommands: boolean
  }
  memory: {
    backend: '本地文件' | 'SQLite' | 'Chroma'
    directory: string
    namespace: string
    retentionDays: number
    autoSave: boolean
  }
}
export type SpecPhaseName = 'Requirements' | 'Design' | 'Planning' | 'Execution' | 'Verification'
export interface SpecPhase {
  name: SpecPhaseName
  steps: { id: string; title: string; owner: string; completed: boolean }[]
}
export interface Task {
  displayId?: string
  id: string
  title: string
  requirementId: string
  agentId: string
  reviewerId?: string
  dependsOn?: string[]
  specPhases?: SpecPhase[]
  status: TaskStatus
  execution: ExecutionState
  statusText: string
  description: string
}
export interface Message {
  id: string
  scopeId: string
  authorId: string
  time: string
  content: string
  taskIds?: string[]
  execution?: 'executing' | 'waiting'
}
export interface TerminalLine {
  text: string
  tone?: 'green' | 'cyan' | 'muted'
}
export interface Session {
  id: string
  taskId: string
  agentId: string
  startedAt: string
  lines: TerminalLine[]
  activities: { time: string; text: string }[]
}
export interface ChatScope {
  id: string
  title: string
  label: string
  projectId?: string
  requirementId?: string
  agentId?: string
  status?: TaskStatus
}
export interface AppData {
  projectError?: string
  agentLoading?: boolean
  agentError?: string
  projects: Project[]
  requirements: Requirement[]
  agents: Agent[]
  tasks: Task[]
  messages: Message[]
  sessions: Session[]
}
