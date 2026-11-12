export interface AgentConfig {
  name: string
  provider: 'pi' | 'codex'
  enabled: boolean
  a2a: { url: string; token_env?: string | null } | null
  directory?: string | null
  executable?: string | null
  native_config?: string | null
  model?: string | null
  prepare?: string | null
}
export interface Agent extends AgentConfig {
  id: string
  online: boolean
  disabled: boolean
  cli: string
  backend: 'native' | 'a2a'
}
export interface Task {
  id: string
  title: string
  status: 'todo' | 'running' | 'done'
}
export interface Requirement {
  id: string
  title: string
  description: string
  tasks: Task[]
}
export interface Project {
  id: string
  name: string
  directories: string[]
  preferred_directory: string | null
  description: string
  requirements: Requirement[]
}
