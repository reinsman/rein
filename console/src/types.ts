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
import type { AgentConfig, Task as StoredTask } from './localTypes'
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
export type AgentConfiguration = Omit<AgentConfig, 'skills'>
export interface Task extends StoredTask {
  queue?: import('./services/workflow').QueueTask
  displayId?: string
  requirementId: string
  agentId: string
  reviewerId?: string
  dependsOn: string[]
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
  specId?: string
  id: string
  title: string
  label: string
  projectId?: string
  requirementId?: string
  agentId?: string
  status?: TaskStatus
}
export interface AppData {
  workflow?: import('./services/workflow').WorkflowSnapshot
  workflowError?: string
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
