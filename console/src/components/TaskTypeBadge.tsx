import type { TaskType } from '../localTypes'
import { taskTypeInfo } from '../services/sdd'
import { Icon } from './shared'

export function TaskTypeBadge({ type }: { type?: TaskType }) {
  const info = type ? taskTypeInfo[type] : { label: '任务', icon: 'doc' }
  return (
    <span className="task-type-badge">
      <Icon name={info.icon} size={14} />
      {info.label}
    </span>
  )
}
