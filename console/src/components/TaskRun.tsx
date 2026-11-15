import { useEffect, useState } from 'react'
import { Alert } from '@mui/material'
import { request, toUpdate, terminalRun, type RunUpdate } from '../services/localService'
import type { Agent } from '../types'
import type { QueueTask } from '../services/workflow'
import { RunMessages } from './AgentChat'

export function TaskRun({ task, agents }: { task: QueueTask; agents: Agent[] }) {
  const [record, setRecord] = useState<RunUpdate>()
  const [error, setError] = useState('')
  const id = task.run_id ?? task.last_run_id
  const agent = agents.find((agent) => agent.id === record?.run.agentId)
  useEffect(() => {
    if (!id) return
    let disposed = false
    const controller = new AbortController()
    let timer: number | undefined
    async function load() {
      try {
        const value = toUpdate(
          await request<Parameters<typeof toUpdate>[0]>(`/api/runs/${id}`, {
            signal: controller.signal,
          }),
        )
        if (disposed) return
        setRecord({ ...value, prompt: task.title })
        setError('')
        if (!terminalRun(value.run)) timer = window.setTimeout(() => void load(), 1000)
      } catch (failure) {
        if (!disposed) setError(String(failure))
      }
    }
    void load()
    return () => {
      disposed = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [id, task.title])
  return (
    <div className="task-run-history">
      {error && <Alert severity="error">{error}</Alert>}
      {record && record.run.id === id && agent ? (
        <RunMessages record={record} agent={agent} userName="任务运行时" />
      ) : (
        <p className="muted">
          {record && record.run.id === id && !agent
            ? '执行 Agent 配置已移除，交接文件仍可查看。'
            : id
              ? '正在读取执行记录…'
              : '尚未领取；运行后将在这里显示工具调用、审批和执行结果。'}
        </p>
      )}
    </div>
  )
}
