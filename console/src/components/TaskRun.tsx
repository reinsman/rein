import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Alert, Button, InputBase, Paper } from '@mui/material'
import {
  chatErrorMessage,
  localService,
  instructionError,
  request,
  toUpdate,
  terminalRun,
  runStateLabel,
  type RunUpdate,
} from '../services/localService'
import type { Agent } from '../types'
import { workflowService, type QueueTask } from '../services/workflow'
import { RunMessages } from './AgentChat'
import { RunChanges } from './RunChanges'
import { AgentAvatar, ChatSendButton } from './shared'
import { preferencesService } from '../services/preferences'
import { chatEnter, steerShortcut, useChatDraft } from './chatDraft'
import { FollowupStatus } from './FollowupStatus'

export function TaskRun({
  task,
  agents,
  artifacts,
  directory,
}: {
  task: QueueTask
  agents: Agent[]
  artifacts: boolean
  directory?: string
}) {
  const {
    draft,
    setDraft,
    sending,
    setSending,
    finishSend,
    queued,
    queueFollowup,
    withdrawFollowup,
  } = useChatDraft(`task:${task.id}`)
  const [records, setRecords] = useState<RunUpdate[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [error, setError] = useState('')
  const [sendError, setSendError] = useState('')
  const [stopping, setStopping] = useState(false)
  const sendRequest = useRef<{ key: string; id: string } | null>(null)
  const refresh = useRef<(runId?: string, reloadSession?: boolean) => Promise<void>>(async () => {})
  const reopenedWhileSending = useRef(sending)
  const loadOlder = useRef<() => Promise<void>>(async () => {})
  const log = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true)
  const { sendMode } = preferencesService.load()
  const id = task.run_id ?? task.last_run_id
  const current = records.at(-1)
  const agent = agents.find((agent) => agent.id === current?.run.agentId)
  useEffect(() => {
    if (!id) return
    const anchorId = id
    let disposed = false
    const controller = new AbortController()
    let timer: number | undefined
    let latestId: string | undefined
    let session: RunUpdate | undefined
    let before = ''
    let revision = 0
    let fetchingOlder = false
    async function read(runId: string) {
      return toUpdate(
        await request<Parameters<typeof toUpdate>[0]>(`/api/runs/${runId}`, {
          signal: controller.signal,
        }),
      )
    }
    async function load(runId?: string, reloadSession = false) {
      if (disposed) return
      window.clearTimeout(timer)
      const requestRevision = ++revision
      if (reloadSession || runId) latestId = runId
      try {
        let latest: RunUpdate
        if (!latestId) {
          session ??= await read(anchorId)
          const page = await localService.history(
            session.run.agentId,
            session.run.sessionId,
            '',
            controller.signal,
          )
          if (disposed || requestRevision !== revision) return
          const history = page.runs.reverse()
          latest = history.at(-1) ?? session
          latestId = latest.run.id
          before = page.next_cursor
          setHasOlder(!!before)
          setRecords(history.length ? history : [latest])
        } else {
          latest = await read(latestId)
          if (disposed || requestRevision !== revision) return
          setRecords((previous) => {
            const last = previous.at(-1)
            if (last?.run.id === latest.run.id && last.version === latest.version) return previous
            return [...previous.filter((record) => record.run.id !== latest.run.id), latest]
          })
        }
        setError('')
        if (!terminalRun(latest.run)) timer = window.setTimeout(() => void load(), 1000)
      } catch (failure) {
        if (!disposed && requestRevision === revision) {
          setError(String(failure))
          timer = window.setTimeout(() => void load(), 2000)
        }
      }
    }
    loadOlder.current = async () => {
      if (!session || !before || fetchingOlder) return
      fetchingOlder = true
      setLoadingOlder(true)
      try {
        const page = await localService.history(
          session.run.agentId,
          session.run.sessionId,
          before,
          controller.signal,
        )
        if (disposed) return
        followBottom.current = false
        before = page.next_cursor
        setHasOlder(!!before)
        setRecords((previous) => [...page.runs.reverse(), ...previous])
        setError('')
      } catch (failure) {
        if (!disposed) setError(String(failure))
      } finally {
        fetchingOlder = false
        if (!disposed) setLoadingOlder(false)
      }
    }
    refresh.current = load
    void load()
    return () => {
      disposed = true
      controller.abort()
      window.clearTimeout(timer)
      refresh.current = async () => {}
      loadOlder.current = async () => {}
    }
  }, [id])
  useEffect(() => {
    if (queued?.posting) {
      reopenedWhileSending.current = true
      return
    }
    if (sending || !reopenedWhileSending.current) return
    reopenedWhileSending.current = false
    void refresh.current(undefined, true)
  }, [sending, queued?.posting])
  useLayoutEffect(() => {
    if (followBottom.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [records, artifacts])
  const followup = !!current && current.run.id !== id
  const ended = !!current && terminalRun(current.run)
  const canGuide =
    !!current &&
    (followup || (task.status === 'running' && !task.paused && task.run_id === current.run.id)) &&
    current.run.state === 'RUN_STATE_RUNNING' &&
    !current.run.cancelRequested &&
    agent?.backend === 'native'
  const canChat = ended && task.status !== 'running' && !!agent?.online
  const active = !!current && !ended
  const canQueue = active && !!agent?.online
  const canSend = canChat || canQueue
  async function postChat(prompt: string, request_id: string) {
    const { run } = await request<{ run: { run_id: string } }>(`/api/tasks/${task.id}/chat`, {
      method: 'POST',
      body: JSON.stringify({ run_id: id, prompt, request_id }),
    })
    await refresh.current(run.run_id)
  }
  async function taskReady(signal: AbortSignal) {
    const latest = (await workflowService.snapshot(signal)).tasks.find(
      (item) => item.id === task.id,
    )
    if (!latest || (latest.run_id ?? latest.last_run_id) !== id)
      throw new Error('任务会话已切换，请检查排队消息')
    return latest.status !== 'running'
  }
  async function send(steer = false) {
    if (!current || sending || stopping || (steer ? !canGuide : !canSend || queued)) return
    const text = draft.trim()
    if (!text) return
    if (new TextEncoder().encode(text).length > 48 * 1024) {
      setSendError('消息不能超过 48 KiB，请缩短后重试。')
      return
    }
    setSendError('')
    if (!steer && canQueue) {
      await queueFollowup(current.run.id, postChat, taskReady)
      return
    }
    const key = `${steer ? current.run.attemptId : current.run.sessionId}:${text}`
    if (sendRequest.current?.key !== key) sendRequest.current = { key, id: crypto.randomUUID() }
    setSending(true)
    try {
      followBottom.current = true
      if (steer) {
        const ack = await localService.instruct(current.run, text, sendRequest.current.id)
        await refresh.current()
        const error = instructionError(ack)
        if (error) {
          if (ack.state === 'COMMAND_ACK_STATE_REJECTED') sendRequest.current = null
          throw new Error(error)
        }
      } else {
        await postChat(text, sendRequest.current.id)
      }
      finishSend()
      sendRequest.current = null
    } catch (failure) {
      setSendError(
        failure instanceof Error
          ? chatErrorMessage(failure.message, current)
          : '发送失败，消息已保留。',
      )
    } finally {
      setSending(false)
    }
  }
  async function stop() {
    if (!current || !followup || ended || stopping) return
    setStopping(true)
    setSendError('')
    try {
      await localService.cancel(current.run, crypto.randomUUID())
      await refresh.current()
    } catch (failure) {
      setSendError(failure instanceof Error ? failure.message : '停止对话失败。')
    } finally {
      setStopping(false)
    }
  }
  const note = !id
    ? '任务开始后，可在这里查看会话并补充指导。'
    : !current
      ? '正在连接任务会话…'
      : canChat
        ? '消息将发到同一个会话，任务状态保持不变。'
        : ended
          ? task.status === 'running'
            ? '正在更新任务状态，稍后可以继续对话。'
            : 'Agent 当前不可用。启用后可继续对话。'
          : current.run.cancelRequested || (!followup && task.paused)
            ? '正在停止执行。Enter 排队，结束后发送。'
            : current.run.state === 'RUN_STATE_WAITING_APPROVAL' ||
                current.run.state === 'RUN_STATE_WAITING_INPUT'
              ? '请先回应上方的审批或提问。Enter 排队，结束后发送。'
              : canGuide
                ? `Enter 排队 · ${steerShortcut} 立即指导`
                : 'Enter 排队，结束后发送。'
  const historyError = error && (
    <Alert severity="error" action={<Button onClick={() => void refresh.current()}>重试</Button>}>
      {error}
    </Alert>
  )
  const older = hasOlder && (
    <Button size="small" disabled={loadingOlder} onClick={() => void loadOlder.current()}>
      加载更早的{artifacts ? '产物' : '消息'}
    </Button>
  )
  if (artifacts) {
    return (
      <div className="task-artifacts">
        {historyError}
        {older}
        <RunChanges
          records={records}
          directory={directory}
          empty={
            error
              ? undefined
              : id && !current
                ? '正在读取产物…'
                : '暂无文件产物。Agent 报告的文件变更会显示在这里。'
          }
        />
      </div>
    )
  }
  return (
    <section className="task-session" aria-label="任务 Agent 会话">
      <header className="task-session-header">
        {agent && <AgentAvatar agent={agent} size={20} />}
        <strong>{agent?.name ?? '执行 Agent'}</strong>
        <span>{current ? runStateLabel[current.run.state] : id ? '连接中' : '尚未开始'}</span>
      </header>
      <div
        className="task-run-history"
        ref={log}
        role="log"
        aria-label="任务会话内容"
        onScroll={(event) => {
          const panel = event.currentTarget
          followBottom.current = panel.scrollHeight - panel.clientHeight - panel.scrollTop < 64
        }}
      >
        {historyError}
        {current && agent ? (
          <>
            {older}
            {records.map((record) => {
              const execution = record.run.id === id
              return (
                <RunMessages
                  key={record.run.id}
                  record={execution ? { ...record, prompt: task.title } : record}
                  agent={agent}
                  userName={execution ? '任务运行时' : '你'}
                  directory={directory}
                />
              )
            })}
          </>
        ) : (
          <p className="muted">
            {current && !agent
              ? '执行 Agent 配置已移除，交接文件仍可查看。'
              : id
                ? '正在读取执行记录…'
                : '尚未领取；运行后将在这里显示工具调用、审批和执行结果。'}
          </p>
        )}
      </div>
      <div className="task-session-composer">
        {sendError && <Alert severity="error">{sendError}</Alert>}
        {queued && <FollowupStatus followup={queued} onWithdraw={withdrawFollowup} />}
        <Paper
          component="form"
          variant="outlined"
          className="composer"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <InputBase
            multiline
            maxRows={5}
            fullWidth
            value={draft}
            disabled={!canSend || sending || stopping}
            placeholder={ended ? '在当前会话继续对话…' : '给任务 Agent 发消息…'}
            inputProps={{ 'aria-label': '给任务 Agent 发消息' }}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              const action = chatEnter(event, active, sendMode)
              if (action) void send(action === 'steer')
            }}
          />
          <div className="composer-actions">
            <span className="hub-connection-note">{sending ? '正在发送…' : '当前任务会话'}</span>
            <span className="spacer" />
            {followup && !ended && (
              <Button
                disabled={stopping || current.run.cancelRequested}
                onClick={() => void stop()}
              >
                停止回复
              </Button>
            )}
            {canGuide && (
              <Button
                size="small"
                disabled={sending || stopping || !draft.trim()}
                onClick={() => void send(true)}
              >
                发送指导
              </Button>
            )}
            <ChatSendButton
              label={active ? '排队发送' : '发送消息'}
              sendMode={sendMode}
              active={active}
              canGuide={canGuide}
              disabled={!canSend || sending || stopping || !!queued || !draft.trim()}
            />
          </div>
        </Paper>
        <p className="task-session-note">{note}</p>
      </div>
    </section>
  )
}
