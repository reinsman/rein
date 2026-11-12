import { LinearProgress } from '@mui/material'
import type { Task } from '../types'

export function SpecProgress({
  task,
  tasks,
  onTask,
}: {
  task: Task
  tasks: Task[]
  onTask: (id: string) => void
}) {
  const phases = task.specPhases ?? []
  const steps = phases.flatMap((phase) => phase.steps)
  const completed = steps.filter((step) => step.completed).length
  const current = phases.find((phase) => phase.steps.some((step) => !step.completed))?.name
  const predecessors = tasks.filter((t) => task.dependsOn?.includes(t.id))
  const successors = tasks.filter((t) => t.dependsOn?.includes(task.id))
  return (
    <div className="spec-activity">
      {(predecessors.length > 0 || successors.length > 0) && (
        <div className="detail-dependencies" aria-label="任务依赖关系">
          {predecessors.map((t) => (
            <div key={t.id}>
              <span>前置任务</span>
              <button onClick={() => onTask(t.id)}>
                {t.id} · {t.title}
              </button>
            </div>
          ))}
          {successors.map((t) => (
            <div key={t.id}>
              <span>后续任务</span>
              <button onClick={() => onTask(t.id)}>
                {t.id} · {t.title}
              </button>
            </div>
          ))}
        </div>
      )}
      <section className="spec-progress" aria-label="Spec 任务执行与追踪">
        <div className="spec-summary">
          <h3>任务执行与追踪</h3>
          <span>
            {completed}/{steps.length} 已完成
          </span>
        </div>
        <LinearProgress
          variant="determinate"
          value={steps.length ? (completed / steps.length) * 100 : 0}
          color="success"
          aria-label="步骤完成进度"
        />
        {phases.length === 0 && (
          <p className="spec-empty">暂无拆解步骤，Agent 拆解任务后将在此展示。</p>
        )}
        {phases.map((phase) => (
          <details className="spec-phase" key={phase.name} open>
            <summary>
              <img className="spec-chevron" src="/icons/spec-down.svg" alt="" />
              <strong>{phase.name}</strong>
              <span>
                {phase.steps.filter((step) => step.completed).length}/{phase.steps.length}
              </span>
              {current === phase.name && <small>当前阶段</small>}
            </summary>
            <ul>
              {phase.steps.map((step) => (
                <li key={step.id} className={step.completed ? 'completed' : ''}>
                  <img
                    className="spec-step-state"
                    src={step.completed ? '/icons/spec-complete.svg' : '/icons/spec-pending.svg'}
                    alt={step.completed ? '已完成' : '未完成'}
                  />
                  {step.completed && (
                    <img className="spec-step-tick" src="/icons/spec-tick.svg" alt="" />
                  )}
                  <div>
                    <span>{step.title}</span>
                    <small>{step.owner}</small>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </section>
    </div>
  )
}
