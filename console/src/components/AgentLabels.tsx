import type { Agent } from '../types'
import type { WorkflowSettings } from '../services/workflow'

export function AgentLabels({ agent, settings }: { agent: Agent; settings?: WorkflowSettings }) {
  const roles = [
    ...(settings?.main_agent === agent.id ? ['主 Agent'] : []),
    ...(settings?.coding_agents.includes(agent.id) ? ['Coding'] : []),
    ...(settings?.review_agents.includes(agent.id) ? ['Review'] : []),
  ]
  if (!roles.length) return null
  return (
    <span className="agent-labels" role="group" aria-label={`${agent.name}角色`}>
      {roles.map((role) => (
        <span className="agent-label agent-role-label" key={role}>
          {role}
        </span>
      ))}
    </span>
  )
}
