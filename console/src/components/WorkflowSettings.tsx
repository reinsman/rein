import { useEffect, useState } from 'react'
import { Alert, Button } from '@mui/material'
import type { Agent } from '../types'
import { localService } from '../services/localService'
import { workflowService, type WorkflowSettings as Configuration } from '../services/workflow'
import { reinService } from '../services/reinService'

export function WorkflowSettings({ notify }: { notify: (message: string) => void }) {
  const [value, setValue] = useState<Configuration>()
  const [agents, setAgents] = useState<Agent[]>([])
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let disposed = false
    void Promise.all([workflowService.snapshot(), localService.agents()])
      .then(([snapshot, items]) => {
        if (!disposed) {
          setValue(snapshot.settings)
          setAgents(items)
        }
      })
      .catch((failure) => {
        if (!disposed) setError(String(failure))
      })
    return () => {
      disposed = true
    }
  }, [])
  async function save() {
    if (!value) return
    setSaving(true)
    setError('')
    try {
      await workflowService.settings(value)
      await reinService.refreshWorkflow()
      notify('主 Agent 和任务角色已保存')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="workflow-settings">
      {error && <Alert severity="error">{error}</Alert>}
      {value ? (
        <>
          <label>
            主 Agent
            <select
              aria-label="主 Agent"
              value={value.main_agent ?? ''}
              disabled={saving}
              onChange={(event) => setValue({ ...value, main_agent: event.target.value || null })}
            >
              <option value="">未配置</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                  {agent.disabled ? '（已下线）' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            Spec 使用主 Agent 规划；任务按角色由空闲 Agent 领取。Coding 与 Review 名单互斥。
          </p>
          <div className="workflow-role-list">
            {agents.map((agent) => (
              <label key={agent.id}>
                <span>
                  {agent.name}
                  {agent.disabled ? ' · 已下线' : ''}
                </span>
                <select
                  aria-label={`${agent.name}任务角色`}
                  disabled={saving}
                  value={
                    value.coding_agents.includes(agent.id)
                      ? 'coding'
                      : value.review_agents.includes(agent.id)
                        ? 'review'
                        : ''
                  }
                  onChange={(event) =>
                    setValue({
                      ...value,
                      coding_agents: [
                        ...value.coding_agents.filter((id) => id !== agent.id),
                        ...(event.target.value === 'coding' ? [agent.id] : []),
                      ],
                      review_agents: [
                        ...value.review_agents.filter((id) => id !== agent.id),
                        ...(event.target.value === 'review' ? [agent.id] : []),
                      ],
                    })
                  }
                >
                  <option value="">不领取任务</option>
                  <option value="coding">Coding</option>
                  <option value="review">Review</option>
                </select>
              </label>
            ))}
          </div>
          <label className="workflow-auto">
            <input
              type="checkbox"
              checked={value.automatic}
              disabled={saving}
              onChange={(event) => setValue({ ...value, automatic: event.target.checked })}
            />
            空闲 Agent 自动领取待开始任务
          </label>
          <p className="muted">
            关闭自动领取后仍可手动开始任务。每个 Spec 顺序执行；同一工作目录只运行一个
            Agent，全局最多 4 个执行。
          </p>
          <Button variant="contained" disabled={saving} onClick={() => void save()}>
            保存编排配置
          </Button>
        </>
      ) : (
        <p>正在读取执行配置…</p>
      )}
    </div>
  )
}
