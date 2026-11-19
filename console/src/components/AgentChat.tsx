import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  FormControlLabel,
  InputAdornment,
  InputBase,
  Paper,
  Popover,
  Radio,
  RadioGroup,
  TextField,
} from '@mui/material'
import { Check, ChevronLeft, ChevronRight, Copy, History, Plus, Search } from 'lucide-react'
import type {
  Agent,
  AgentEvent,
  AgentRun,
  HistoryPage,
  RunRecord,
  RunUpdate,
} from '../services/localService'
import {
  chatErrorMessage,
  decodeJson,
  instructionError,
  localService,
  runStateLabel,
  terminalRun,
  toUpdate,
  request,
} from '../services/localService'
import { Action, AgentAvatar, ChatSendButton, Icon } from './shared'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  taskMessagePreview,
  workflowService,
  type Spec,
  type Conversation,
  type TaskMessage,
  type WorkflowSnapshot,
} from '../services/workflow'
import { reinService } from '../services/reinService'
import { RunChanges } from './RunChanges'
import { HandoffLinks } from './HandoffLinks'
import { chatEnter, steerShortcut, useChatDraft } from './chatDraft'
import { FollowupStatus } from './FollowupStatus'

function visiblePrompt(prompt: string) {
  const marker = '\nREIN_SPEC_USER_MESSAGE:\n'
  const index = prompt.lastIndexOf(marker)
  if (index >= 0) {
    try {
      const message = JSON.parse(prompt.slice(index + marker.length)) as { text?: string }
      if (typeof message.text === 'string') return message.text
    } catch {
      /* Older records still display their saved prompt. */
    }
  }
  return prompt.split('\nUSER MESSAGE:\n').pop() ?? prompt
}

type LoadedRun = RunUpdate
type Interaction = NonNullable<AgentEvent['interaction']>
type SessionSummary = HistoryPage['sessions'][number]
function pendingRecord(run: AgentRun, prompt: string): LoadedRun {
  return { version: '0', run, prompt, created_at: new Date().toISOString(), events: [] }
}
function savedSession(agentId: string) {
  try {
    return localStorage.getItem(`rein.session.${agentId}`)
  } catch {
    return null
  }
}
function persistSession(agentId: string, session: string) {
  try {
    localStorage.setItem(`rein.session.${agentId}`, session)
  } catch {
    /* 当前页仍保留会话。 */
  }
}

export function AgentChat({
  agent,
  userName,
  sendMode,
  spec,
  conversation,
  title,
  onSettings,
  hasUnsavedSpec,
  onActiveChange,
  messages = [],
  members = [],
  workflow,
  onTask,
}: {
  agent: Agent
  userName: string
  sendMode: string
  spec?: Spec
  conversation?: Conversation
  title?: string
  onSettings?: () => void
  hasUnsavedSpec?: () => boolean
  onActiveChange?: (active: boolean) => void
  messages?: TaskMessage[]
  members?: Agent[]
  workflow?: WorkflowSnapshot
  onTask?: (id: string) => void
}) {
  const contextId = spec?.id ?? conversation?.id ?? ''
  const [records, setRecords] = useState<LoadedRun[]>([])
  const cache = useRef(new Map<string, LoadedRun>())
  const [selectedSession, setSession] = useState(
    () => spec?.session_id ?? conversation?.session_id ?? savedSession(agent.id),
  )
  const session = selectedSession ?? ''
  const sessionRef = useRef(session)
  const draftKey = spec
    ? `spec:${spec.id}`
    : conversation
      ? `scope:${conversation.requirement_id}`
      : `agent:${agent.id}:${session}`
  const {
    draft,
    setDraft,
    sending,
    setSending,
    finishSend,
    queued,
    queueFollowup,
    withdrawFollowup,
  } = useChatDraft(draftKey)
  const [error, setError] = useState('')
  const [pollError, setPollError] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyButton = useRef<HTMLButtonElement>(null)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState<string>()
  const sendRequest = useRef<{ key: string; id: string } | null>(null)
  const cancelRequest = useRef(new Map<string, string>())
  const log = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const freshSession = useRef(!contextId && selectedSession === '')
  const loadHistory = useRef<(session: string, older: boolean) => Promise<void>>(async () => {})
  const cursors = useRef(new Map<string, string>())
  const cancelHistory = useRef<() => void>(() => {})
  const followBottom = useRef(true)
  const restoreScroll = useRef<{ key: string; top: number } | null>(null)
  function publishRecords() {
    setRecords(
      [...cache.current.values()].sort(
        (a, b) => a.created_at.localeCompare(b.created_at) || a.run.id.localeCompare(b.run.id),
      ),
    )
  }
  function merge(record: RunUpdate) {
    const old = cache.current.get(record.run.id)
    const newer = !old || BigInt(record.version) >= BigInt(old.version)
    const sameAttempt = old?.run.attemptId === record.run.attemptId
    if (old && !sameAttempt && !newer) return
    const events = new Map((sameAttempt ? old!.events : []).map((event) => [event.sequence, event]))
    for (const event of record.events) events.set(event.sequence, event)
    cache.current.set(record.run.id, {
      ...(newer ? record : old!),
      events: [...events.values()].sort((a, b) =>
        BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1,
      ),
    })
  }
  function rememberSession(record: RunRecord) {
    const { sessionId: id } = record.run
    setSessions((previous) =>
      previous.some((item) => item.id === id)
        ? previous
        : [{ id, prompt: record.prompt, created_at: record.created_at }, ...previous],
    )
  }
  function chooseSession(value: string, fetchHistory = true) {
    sessionRef.current = value
    setSession(value)
    if (!contextId) persistSession(agent.id, value)
    followBottom.current = true
    setHasMore(!!cursors.current.get(value))
    if (fetchHistory) {
      if (value) void loadHistory.current(value, false)
      else cancelHistory.current()
    }
  }
  function closeSessionHistory() {
    setHistoryOpen(false)
    requestAnimationFrame(() => historyButton.current?.focus())
  }
  useEffect(() => {
    let disposed = false
    let source: EventSource | undefined
    let historyController: AbortController | undefined
    let requestNumber = 0
    let fetchingOlder = false
    let streamCursor = ''
    cancelHistory.current = () => {
      historyController?.abort()
      requestNumber++
      fetchingOlder = false
      setLoading(false)
      setLoadingOlder(false)
    }
    function connect(cursor: string) {
      source?.close()
      streamCursor = cursor
      const connection = localService.stream(agent.id, cursor)
      source = connection
      connection.onopen = () => {
        if (!disposed && source === connection) setPollError('')
      }
      connection.onerror = () => {
        if (!disposed && source === connection)
          setPollError('实时连接已断开，正在重连；已有记录仍可查看。')
      }
      connection.addEventListener('update', (message) => {
        if (disposed || source !== connection) return
        try {
          const record = toUpdate(JSON.parse(message.data))
          merge(record)
          rememberSession(record)
          publishRecords()
        } catch {
          source?.close()
          source = undefined
          setPollError('reind 实时事件无效，请重试加载。')
        }
      })
      connection.addEventListener('stream_error', (message) => {
        if (!disposed && source === connection) setPollError(message.data)
      })
    }
    loadHistory.current = async (requestedSession, older) => {
      const before = older ? cursors.current.get(requestedSession) || '' : ''
      if (older && (fetchingOlder || !before)) return
      historyController?.abort()
      const controller = new AbortController()
      historyController = controller
      const currentRequest = ++requestNumber
      fetchingOlder = older
      if (older) setLoadingOlder(true)
      else {
        setLoading(true)
        setLoadingOlder(false)
      }
      try {
        const page = await localService.history(
          agent.id,
          requestedSession,
          before,
          controller.signal,
        )
        if (disposed || currentRequest !== requestNumber) return
        if (older && log.current) {
          const top = log.current.getBoundingClientRect().top
          const anchor = [...log.current.querySelectorAll<HTMLElement>('[data-run-anchor]')].find(
            (item) => item.getBoundingClientRect().bottom > top,
          )
          if (anchor)
            restoreScroll.current = {
              key: anchor.dataset.runAnchor!,
              top: anchor.getBoundingClientRect().top,
            }
        }
        for (const record of page.runs) merge(record)
        setSessions((previous) => [
          ...page.sessions,
          ...previous.filter((item) => !page.sessions.some((entry) => entry.id === item.id)),
        ])
        cursors.current.set(page.session_id, page.next_cursor)
        if (!freshSession.current || requestedSession) {
          sessionRef.current = page.session_id
          setSession(page.session_id)
          if (!contextId) persistSession(agent.id, page.session_id)
          setHasMore(!!page.next_cursor)
        }
        publishRecords()
        setPollError('')
        if ((!source || source.readyState === EventSource.CLOSED) && !document.hidden)
          connect(page.stream_cursor)
        else if (!streamCursor) streamCursor = page.stream_cursor
      } catch (failure) {
        if (!disposed && !controller.signal.aborted)
          setPollError(failure instanceof Error ? failure.message : '读取对话记录失败')
      } finally {
        if (!disposed && currentRequest === requestNumber) {
          fetchingOlder = false
          setLoading(false)
          setLoadingOlder(false)
        }
      }
    }
    function visibility() {
      if (document.hidden) {
        source?.close()
        source = undefined
      } else if (streamCursor) connect(streamCursor)
      else void loadHistory.current(sessionRef.current, false)
    }
    document.addEventListener('visibilitychange', visibility)
    void loadHistory.current(sessionRef.current, false)
    return () => {
      disposed = true
      historyController?.abort()
      source?.close()
      document.removeEventListener('visibilitychange', visibility)
      loadHistory.current = async () => {}
      cancelHistory.current = () => {}
    }
  }, [agent.id, contextId])
  const visible = records.filter((record) => record.run.sessionId === session)
  const timeline = [
    ...visible.map((record) => ({
      kind: 'run' as const,
      record,
      time: Date.parse(record.created_at),
    })),
    ...messages.map((message) => ({
      kind: 'task' as const,
      message,
      time: message.created_at,
      ...taskMessagePreview(message, workflow),
    })),
  ].sort((a, b) => a.time - b.time)
  const active = visible.find((record) => !terminalRun(record.run))
  const canGuide =
    agent.backend === 'native' &&
    active?.run.state === 'RUN_STATE_RUNNING' &&
    !active.run.cancelRequested
  const running = Boolean(active || sending || starting || loading)
  useEffect(() => {
    onActiveChange?.(running)
    return () => onActiveChange?.(false)
  }, [running, onActiveChange])
  useLayoutEffect(() => {
    const panel = log.current
    if (!panel || historyOpen) return
    if (restoreScroll.current) {
      const anchor = panel.querySelector<HTMLElement>(
        `[data-run-anchor="${CSS.escape(restoreScroll.current.key)}"]`,
      )
      if (anchor) panel.scrollTop += anchor.getBoundingClientRect().top - restoreScroll.current.top
      restoreScroll.current = null
    } else if (followBottom.current) panel.scrollTop = panel.scrollHeight
  }, [records, session, messages.length, historyOpen])
  async function postChat(text: string, requestId: string, expectedSession?: string) {
    if (spec && hasUnsavedSpec?.()) {
      throw new Error('请先保存右侧 Spec 草稿，再继续对话或确认阶段。')
    }
    const response = conversation
      ? await workflowService.requirementChat(
          conversation.requirement_id,
          text,
          requestId,
          expectedSession,
        )
      : spec
        ? await workflowService.chat(spec.id, text, requestId, undefined, expectedSession)
        : await localService.create(agent.id, session, text, requestId)
    const record = cache.current.get(response.run.id) ?? pendingRecord(response.run, text)
    cache.current.set(response.run.id, record)
    if (!contextId) rememberSession(record)
    publishRecords()
    const stillSelected = sessionRef.current === session
    if (stillSelected) {
      chooseSession(response.run.sessionId, false)
      freshSession.current = false
    }
    return stillSelected && !contextId && !session
      ? `agent:${agent.id}:${response.run.sessionId}`
      : draftKey
  }
  async function send(steer = false) {
    const text = draft.trim()
    if (!text || loading || sending || !agent.online || (steer ? !canGuide : queued)) return
    if (spec && hasUnsavedSpec?.()) {
      setError('请先保存右侧 Spec 草稿，再继续对话或确认阶段。')
      return
    }
    const limit = contextId && !steer ? 32 : 48
    if (new TextEncoder().encode(text).length > limit * 1024) {
      setError(`消息不能超过 ${limit} KiB，请缩短后重试。`)
      return
    }
    setError('')
    if (active && !steer) {
      await queueFollowup(active.run.id, async (text, requestId) => {
        await postChat(text, requestId, active.run.sessionId)
      })
      return
    }
    const key = `${steer ? active?.run.attemptId : session}:${draft}`
    if (sendRequest.current?.key !== key) sendRequest.current = { key, id: crypto.randomUUID() }
    setSending(true)
    try {
      if (steer && active) {
        const ack = await localService.instruct(active.run, text, sendRequest.current.id)
        const error = instructionError(ack)
        if (error) {
          if (ack.state === 'COMMAND_ACK_STATE_REJECTED') sendRequest.current = null
          throw new Error(error)
        }
        finishSend()
      } else {
        finishSend(await postChat(text, sendRequest.current.id))
      }
      sendRequest.current = null
    } catch (failure) {
      setError(
        failure instanceof Error
          ? chatErrorMessage(failure.message, visible.at(-1))
          : '发送失败，消息已保留，请重试。',
      )
    } finally {
      setSending(false)
      if (document.activeElement === document.body || document.activeElement?.closest('.composer'))
        input.current?.focus()
    }
  }
  async function begin() {
    if (!spec) return
    setStarting(true)
    setError('')
    try {
      await workflowService.beginSpec(spec.id)
      await reinService.refreshWorkflow()
      await loadHistory.current(sessionRef.current, false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '开始对话失败，请重试。')
    } finally {
      setStarting(false)
    }
  }
  async function cancel(run: AgentRun) {
    let command = cancelRequest.current.get(run.id)
    if (!command) {
      command = crypto.randomUUID()
      cancelRequest.current.set(run.id, command)
    }
    setCancelling(run.id)
    try {
      await localService.cancel(run, command)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '取消请求失败，请重试。')
    } finally {
      setCancelling(undefined)
    }
  }
  return (
    <section className="chat-panel" aria-label="Agent 对话">
      <header className="panel-header chat-header">
        {conversation ? <Icon name="people" size={24} /> : <AgentAvatar agent={agent} size={24} />}
        <div className="chat-heading">
          <h1>{title ?? agent.name}</h1>
          <span>
            {conversation
              ? `需求讨论 · ${agent.name}`
              : spec
                ? `主 Agent · ${agent.name}`
                : agent.backend === 'native'
                  ? `${agent.cli} · 原生`
                  : 'A2A'}{' '}
            · {agent.disabled ? 'Agent 已下线' : agent.online ? '在线' : 'reind 离线'}
          </span>
        </div>
        {contextId ? (
          <Action
            label={conversation ? '需求配置' : 'Spec 配置'}
            icon="settings"
            onClick={() => onSettings?.()}
          />
        ) : (
          <Fragment>
            {!historyOpen && (
              <Button
                ref={historyButton}
                color="inherit"
                startIcon={<Icon name={History} />}
                onClick={() => setHistoryOpen(true)}
              >
                会话历史
              </Button>
            )}
            <Button
              startIcon={<Icon name={Plus} />}
              onClick={() => {
                freshSession.current = true
                chooseSession('')
                setHistoryOpen(false)
              }}
            >
              新对话
            </Button>
          </Fragment>
        )}
      </header>
      {(error || pollError) && (
        <Alert
          severity="error"
          className="hub-alert"
          action={
            <Button
              onClick={() => {
                void loadHistory.current(sessionRef.current, false)
              }}
            >
              重试
            </Button>
          }
        >
          {error || pollError}
        </Alert>
      )}
      {!agent.online && (
        <Alert severity="warning" className="hub-alert">
          {agent.disabled
            ? `此 Agent 已下线，历史记录仍可查看。通过 rein agent up ${agent.name} 上线后可继续对话。`
            : 'Daemon 当前离线。执行记录仍可查看，连接恢复后可继续对话。'}
        </Alert>
      )}
      {historyOpen && (
        <SessionHistory
          sessions={sessions}
          session={session}
          loading={loading}
          onBack={closeSessionHistory}
          onSelect={(id) => {
            if (id !== session) {
              freshSession.current = false
              chooseSession(id)
            }
            closeSessionHistory()
          }}
        />
      )}
      <div
        className="messages"
        hidden={historyOpen}
        ref={log}
        role="log"
        aria-label={`${agent.name}的聊天记录`}
        aria-live="polite"
        aria-busy={loading}
        onScroll={(event) => {
          if (historyOpen) return
          const panel = event.currentTarget
          followBottom.current = panel.scrollHeight - panel.clientHeight - panel.scrollTop < 64
          if (panel.scrollTop < 40 && hasMore && !loading && !loadingOlder)
            void loadHistory.current(sessionRef.current, true)
        }}
      >
        {hasMore && (
          <Button
            size="small"
            disabled={loading || loadingOlder}
            onClick={() => {
              void loadHistory.current(sessionRef.current, true)
            }}
          >
            {loadingOlder ? '正在加载更早记录…' : '加载更早记录'}
          </Button>
        )}
        {!timeline.length && (
          <div className="empty-message">
            <Icon name="chat" />
            <p>{loading ? '正在读取执行记录…' : `与 ${agent.name} 开始对话`}</p>
            {spec ? (
              <Button
                variant="contained"
                disabled={loading || starting || !agent.online}
                onClick={() => void begin()}
              >
                {starting ? '正在开始…' : spec.error ? '重试开始对话' : '开始 Spec 对话'}
              </Button>
            ) : (
              <span>消息会交给已注册的 Agent 执行。</span>
            )}
          </div>
        )}
        {timeline.map((item) =>
          item.kind === 'run' ? (
            <RunMessages
              key={item.record.run.id}
              record={
                contextId
                  ? {
                      ...item.record,
                      prompt: visiblePrompt(item.record.prompt),
                    }
                  : item.record
              }
              agent={agent}
              userName={userName}
            />
          ) : (
            <Fragment key={item.message.id}>
              <article
                className="message agent-message"
                key={item.message.id}
                data-task-message={item.message.kind}
              >
                <AgentAvatar
                  agent={members.find((agent) => agent.id === item.message.agent_id)}
                  runtime
                />
                <div className="message-content">
                  <div className="message-author">
                    <strong>
                      {members.find((agent) => agent.id === item.message.agent_id)?.name ||
                        item.message.agent_id}
                    </strong>
                    <time dateTime={new Date(item.message.created_at).toISOString()}>
                      {new Date(item.message.created_at).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>
                  <Paper
                    elevation={0}
                    className={`message-bubble${item.message.kind === 'waiting' ? ' waiting-message' : ''}`}
                  >
                    <span>{item.content.replaceAll('@用户', `@${userName}`)}</span>
                  </Paper>
                  {item.preview && <HandoffLinks {...item.preview} />}
                  {onTask && (
                    <Button onClick={() => onTask(item.message.task_id)}>
                      {item.message.kind === 'waiting' ? '查看任务交互' : '查看任务'}
                    </Button>
                  )}
                  {item.message.update_error && (
                    <Button
                      onClick={() =>
                        void workflowService
                          .retryTaskUpdate(item.message.id)
                          .then(() => reinService.refreshWorkflow())
                          .catch((failure) => setError(String(failure)))
                      }
                    >
                      重试文档同步
                    </Button>
                  )}
                </div>
              </article>
              {item.message.kind === 'update_waiting' &&
                item.message.run_id &&
                messages.findLast(
                  (message) =>
                    message.kind === 'update_waiting' && message.run_id === item.message.run_id,
                )?.id === item.message.id && <RunInteraction id={item.message.run_id} />}
            </Fragment>
          ),
        )}
      </div>
      <div className="composer-dock hub-composer-dock" hidden={historyOpen}>
        {active && (
          <div className="hub-run-status" role="status">
            <span>
              {runStateLabel[active.run.state] || active.run.state}
              {active.run.cancelRequested ? ' · 已请求取消，等待执行停止' : ''}
            </span>
            <Button
              size="small"
              color="error"
              disabled={cancelling === active.run.id || active.run.cancelRequested}
              onClick={() => {
                void cancel(active.run)
              }}
            >
              停止执行
            </Button>
          </div>
        )}
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
            inputRef={input}
            multiline
            maxRows={5}
            fullWidth
            value={draft}
            onChange={(event) => {
              if (!contextId && !session && !freshSession.current) {
                freshSession.current = true
                persistSession(agent.id, '')
              }
              setDraft(event.target.value)
            }}
            placeholder={`发送给 ${agent.name}…`}
            inputProps={{ 'aria-label': '发送消息' }}
            onKeyDown={(event) => {
              const action = chatEnter(event, !!active, sendMode)
              if (action) void send(action === 'steer')
            }}
          />
          <div className="composer-actions">
            <span className="hub-connection-note">
              {active
                ? canGuide
                  ? `Enter 排队 · ${steerShortcut} 立即指导`
                  : 'Enter 排队，结束后发送'
                : agent.backend === 'native'
                  ? '原生 Agent'
                  : 'A2A Agent'}
            </span>
            <span className="spacer" />
            {canGuide && (
              <Button
                size="small"
                disabled={loading || sending || !agent.online || !draft.trim()}
                onClick={() => void send(true)}
              >
                发送指导
              </Button>
            )}
            <ChatSendButton
              label={active ? '排队发送' : '发送消息按钮'}
              sendMode={sendMode}
              active={!!active}
              canGuide={canGuide}
              disabled={loading || sending || !!queued || !agent.online || !draft.trim()}
              className="send-button"
            />
          </div>
        </Paper>
      </div>
    </section>
  )
}

function sessionText(prompt: string) {
  const text = visiblePrompt(prompt).trim()
  if (text.startsWith('REIN TASK RUNTIME\n')) {
    return {
      title: text.match(/^TITLE: (.+)$/m)?.[1] || '任务执行',
      preview: text.match(/^DESCRIPTION: (.+)$/m)?.[1] || '',
    }
  }
  if (text.startsWith('REIN SPEC TASK UPDATE\n')) {
    const payload = text.split('\nTASK_UPDATE_JSON: ').at(-1) ?? ''
    let preview = ''
    try {
      const update = decodeJson<{ report?: string }>(payload)
      if (typeof update?.report === 'string') preview = update.report.trim()
    } catch {
      // Older records may lack a structured report.
    }
    return { title: '同步 Spec 任务状态', preview }
  }
  const [title, ...rest] = text.split('\n')
  return { title: title.trim() || '未命名会话', preview: rest.join(' ').trim() }
}

function SessionHistory({
  sessions,
  session,
  loading,
  onBack,
  onSelect,
}: {
  sessions: SessionSummary[]
  session: string
  loading: boolean
  onBack: () => void
  onSelect: (id: string) => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const [query, setQuery] = useState('')
  const [today] = useState(() => new Date())
  const term = query.trim().toLowerCase()
  const entries = useMemo(
    () => sessions.map((item) => ({ ...item, ...sessionText(item.prompt) })),
    [sessions],
  ).filter(({ title, preview }) => `${title} ${preview}`.toLowerCase().includes(term))
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  useLayoutEffect(() => heading.current?.focus(), [])

  return (
    <section className="hub-session-history" aria-label="会话历史" aria-busy={loading}>
      <div className="hub-session-history-content">
        <Button color="inherit" startIcon={<Icon name={ChevronLeft} />} onClick={onBack}>
          返回对话
        </Button>
        <h2 ref={heading} tabIndex={-1}>
          会话历史
        </h2>
        <TextField
          type="search"
          fullWidth
          value={query}
          placeholder="搜索会话"
          onChange={(event) => setQuery(event.target.value)}
          slotProps={{
            htmlInput: { 'aria-label': '搜索会话' },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Icon name={Search} size={17} />
                </InputAdornment>
              ),
            },
          }}
        />
        {entries.length ? (
          <ul>
            {entries.map(({ id, title, preview, created_at }) => {
              const date = created_at ? new Date(created_at) : null
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="hub-session-history-row"
                    aria-current={id === session || undefined}
                    onClick={() => onSelect(id)}
                  >
                    <span className="hub-session-history-label">
                      <span>
                        <strong title={title}>{title}</strong>
                        {id === session && <small>当前会话</small>}
                      </span>
                      {preview && <span className="hub-session-history-preview">{preview}</span>}
                    </span>
                    {date && Number.isFinite(date.getTime()) && (
                      <time dateTime={created_at}>
                        {date.toDateString() === today.toDateString()
                          ? '今天'
                          : date.toDateString() === yesterday.toDateString()
                            ? '昨天'
                            : date.toLocaleDateString('zh-CN', {
                                month: 'short',
                                day: 'numeric',
                                year:
                                  date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
                              })}
                      </time>
                    )}
                    <Icon name={ChevronRight} />
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="hub-session-history-empty" role="status">
            {loading ? '正在读取会话历史…' : term ? '没有找到匹配的会话' : '还没有会话'}
          </p>
        )}
      </div>
    </section>
  )
}

export function RunMessages({
  record,
  agent,
  userName,
  directory = agent.directory ?? undefined,
}: {
  record: LoadedRun
  agent: Agent
  userName: string
  directory?: string
}) {
  const changeRecords = useMemo(() => [record], [record])
  const [now, setNow] = useState(Date.now)
  const [infoAnchor, setInfoAnchor] = useState<HTMLElement | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const done = terminalRun(record.run)
  useEffect(() => {
    if (done) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [done])
  const items = new Map<
    string,
    | { kind: 'text'; text: string; reasoning: boolean }
    | { kind: 'tool'; tool: NonNullable<AgentEvent['tool']> }
  >()
  const errors: string[] = []
  let interaction: Interaction | undefined
  for (const event of record.events) {
    if (event.text) {
      const item = event.text
      const key = `${item.reasoning ? 'reasoning' : 'text'}:${item.itemId}`
      const previous = items.get(key)
      items.set(key, {
        kind: 'text',
        text: item.complete
          ? item.text
          : (previous?.kind === 'text' ? previous.text : '') + item.text,
        reasoning: item.reasoning,
      })
    }
    if (event.tool) {
      const key = `tool:${event.tool.callId}`
      const previous = items.get(key)
      const tool = previous?.kind === 'tool' ? previous.tool : undefined
      items.set(key, {
        kind: 'tool',
        tool: {
          ...tool,
          ...event.tool,
          inputJson: event.tool.inputJson || tool?.inputJson || '',
          outputJson: event.tool.outputJson || tool?.outputJson || '',
        },
      })
    }
    if (event.interaction) interaction = event.interaction
    if (event.error) {
      const message = chatErrorMessage(event.error.message)
      if (!errors.includes(message)) errors.push(message)
    }
  }
  const waiting = ['RUN_STATE_WAITING_APPROVAL', 'RUN_STATE_WAITING_INPUT'].includes(
    record.run.state,
  )
  const when = new Date(record.created_at).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })
  const lastItem = Array.from(items.values()).at(-1)
  const answer = done && lastItem?.kind === 'text' && !lastItem.reasoning ? lastItem.text : ''
  const elapsed = record.run.finishedAt
    ? record.run.finishedAt - Date.parse(record.created_at)
    : done
      ? null
      : now - Date.parse(record.created_at)
  const seconds = elapsed === null ? null : Math.max(0, Math.floor(elapsed / 1000))
  const duration =
    seconds === null
      ? '未记录'
      : `${seconds >= 3600 ? `${Math.floor(seconds / 3600)}小时 ` : ''}${
          seconds >= 60 ? `${Math.floor(seconds / 60) % 60}分 ` : ''
        }${seconds % 60}秒`
  const durationLabel =
    seconds === null
      ? '用时未记录'
      : `${done ? '用时' : runStateLabel[record.run.state] || '执行中'} ${duration}`
  const renderedItems = Array.from(items, ([id, item]) => {
    if (item.kind === 'tool') {
      const tool = item.tool
      const parameters = decodeJson(tool.inputJson)
      const preview = Object.values(parameters).find((value) => typeof value === 'string')
      return (
        <details className={`hub-tool${tool.isError ? ' hub-tool-error' : ''}`} key={id}>
          <summary className="hub-activity-summary">
            <Icon name="code" size={14} />
            <span className="hub-activity-label">
              {tool.complete ? (tool.isError ? '执行失败' : '已运行') : '正在运行'} {tool.name}
            </span>
            <span className="hub-activity-preview">{preview}</span>
            <span className="hub-activity-chevron">
              <Icon name="down" size={12} />
            </span>
          </summary>
          <div className="hub-activity-content">
            <strong>参数</strong>
            <pre>{JSON.stringify(parameters, null, 2)}</pre>
            <strong>结果</strong>
            <pre>{JSON.stringify(decodeJson(tool.outputJson), null, 2)}</pre>
          </div>
        </details>
      )
    }
    return item.reasoning ? (
      <details className="hub-reasoning" key={id}>
        <summary className="hub-activity-summary">
          <Icon name="clock" size={14} />
          <span className="hub-activity-label">思考摘要</span>
          <span className="hub-activity-preview">{item.text}</span>
          <span className="hub-activity-chevron">
            <Icon name="down" size={12} />
          </span>
        </summary>
        <div className="hub-activity-content">
          <p>{item.text}</p>
        </div>
      </details>
    ) : (
      <div key={id} className="hub-message-text">
        <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
      </div>
    )
  })
  const progress = answer ? renderedItems.slice(0, -1) : renderedItems
  async function copyAnswer() {
    try {
      await navigator.clipboard.writeText(answer)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('error')
    }
  }
  return (
    <>
      {!record.prompt.startsWith('REIN SPEC TASK UPDATE\n') && (
        <article className="message own" data-run-anchor={`${record.run.id}-user`}>
          <div className="message-content">
            <div className="message-author">
              <span>
                {userName}　{when}
              </span>
            </div>
            <div className="message-bubble-row">
              <Paper elevation={0} className="message-bubble">
                <span>{record.prompt}</span>
              </Paper>
              <AgentAvatar />
            </div>
          </div>
        </article>
      )}
      {record.command_acks
        ?.filter((ack) => ack.instruction)
        .map((ack) => (
          <article className="message own" key={ack.commandId}>
            <div className="message-content">
              <div className="message-author">
                <span>
                  你 · 运行中指导 ·{' '}
                  {ack.state === 'COMMAND_ACK_STATE_APPLIED'
                    ? 'Agent 已接收'
                    : ack.state === 'COMMAND_ACK_STATE_REJECTED'
                      ? '发送失败'
                      : '接收状态待确认'}
                </span>
              </div>
              <div className="message-bubble-row">
                <Paper elevation={0} className="message-bubble">
                  <span>{ack.instruction}</span>
                </Paper>
                <AgentAvatar />
              </div>
            </div>
          </article>
        ))}
      <article className="message agent-message" data-run-anchor={`${record.run.id}-agent`}>
        <AgentAvatar agent={agent} />
        <div className="message-content">
          <div className="message-author">
            <strong>{agent.name}</strong>
            {record.run.finishedAt ? (
              <time
                dateTime={new Date(record.run.finishedAt).toISOString()}
                title="本轮回答结束时间"
              >
                {new Date(record.run.finishedAt).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            ) : done ? (
              <span className="hub-state-label">结束时间未记录</span>
            ) : null}
          </div>
          {progress.length > 0 ? (
            <details className="hub-progress">
              <summary className="hub-activity-summary">
                <span>{durationLabel}</span>
                <span className="hub-activity-chevron">
                  <Icon name="down" size={12} />
                </span>
              </summary>
              <div className="hub-progress-content">{progress}</div>
            </details>
          ) : (
            <span className="hub-duration">{durationLabel}</span>
          )}
          {answer && <div className="hub-final-answer">{renderedItems.at(-1)}</div>}
          <RunChanges records={changeRecords} directory={directory} />
          {!items.size && !errors.length && !waiting && (
            <span className="hub-placeholder">
              {terminalRun(record.run) ? runStateLabel[record.run.state] : '等待 Agent 输出…'}
            </span>
          )}
          {errors.map((error, index) => (
            <Alert severity="error" key={index}>
              {error}
            </Alert>
          ))}
          <div className={`hub-message-actions${infoAnchor ? ' is-open' : ''}`}>
            {answer && (
              <Action
                label={copyStatus === 'copied' ? '已复制' : '复制回答'}
                onClick={() => {
                  void copyAnswer()
                }}
              >
                {copyStatus === 'copied' ? <Check size={14} /> : <Copy size={14} />}
              </Action>
            )}
            <Action
              label="执行信息"
              icon="info"
              onClick={(event) => setInfoAnchor(event.currentTarget)}
            />
          </div>
          {copyStatus === 'error' && (
            <Alert severity="error">复制失败，请检查浏览器剪贴板权限后重试。</Alert>
          )}
          <Popover
            open={!!infoAnchor}
            anchorEl={infoAnchor}
            onClose={() => setInfoAnchor(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          >
            <section className="hub-run-reference" aria-label="执行信息">
              <h3>执行信息</h3>
              <dl>
                <dt>状态</dt>
                <dd>{runStateLabel[record.run.state] || record.run.state}</dd>
                <dt>用时</dt>
                <dd>{duration}</dd>
                <dt>Run</dt>
                <dd>{record.run.id}</dd>
                <dt>Attempt</dt>
                <dd>{record.run.attemptId || '待领取'}</dd>
                <dt>Session</dt>
                <dd>{record.run.sessionId}</dd>
              </dl>
            </section>
          </Popover>
        </div>
      </article>
      {waiting && interaction && (
        <InteractionForm
          key={`${record.run.attemptId}:${interaction.interactionId}`}
          run={record.run}
          interaction={interaction}
          events={record.events}
          acknowledgments={record.command_acks || []}
        />
      )}
    </>
  )
}

function RunInteraction({ id }: { id: string }) {
  const [record, setRecord] = useState<RunUpdate>()
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    let timer: number | undefined
    const controller = new AbortController()
    async function load() {
      try {
        const next = toUpdate(
          await request<Parameters<typeof toUpdate>[0]>(`/api/runs/${id}`, {
            signal: controller.signal,
          }),
        )
        if (disposed) return
        setRecord(next)
        setError('')
        if (!terminalRun(next.run)) timer = window.setTimeout(() => void load(), 1000)
      } catch (failure) {
        if (!disposed) {
          setError(String(failure))
          timer = window.setTimeout(() => void load(), 2000)
        }
      }
    }
    void load()
    return () => {
      disposed = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [id])
  const interaction = record?.events.findLast((event) => event.interaction)?.interaction
  return (
    <>
      {error && <Alert severity="error">{error}</Alert>}
      {record &&
        interaction &&
        ['RUN_STATE_WAITING_INPUT', 'RUN_STATE_WAITING_APPROVAL'].includes(record.run.state) && (
          <InteractionForm
            key={`${record.run.attemptId}:${interaction.interactionId}`}
            run={record.run}
            interaction={interaction}
            events={record.events}
            acknowledgments={record.command_acks || []}
          />
        )}
    </>
  )
}

type QuestionOption = { label: string; description?: string }

function QuestionInput({
  title,
  options = [],
  onAnswer,
  disabled,
  secret = false,
}: {
  title: string
  options?: QuestionOption[]
  onAnswer: (answer: string) => void
  disabled: boolean
  secret?: boolean
}) {
  const [choice, setChoice] = useState(options.length ? '' : 'custom')
  const [custom, setCustom] = useState('')
  return (
    <fieldset className="hub-question" disabled={disabled}>
      <legend>{title}</legend>
      {options.length > 0 && (
        <RadioGroup
          aria-label="回答选项"
          value={choice}
          onChange={(_, value) => {
            setChoice(value)
            onAnswer(value === 'custom' ? custom : options[Number(value)].label)
          }}
        >
          {options.map((option, index) => (
            <FormControlLabel
              key={index}
              value={String(index)}
              disabled={disabled}
              control={<Radio size="small" />}
              label={
                <span className="hub-question-option">
                  <strong>{option.label}</strong>
                  {option.description && <span>{option.description}</span>}
                </span>
              }
            />
          ))}
          <FormControlLabel
            value="custom"
            disabled={disabled}
            control={<Radio size="small" />}
            label="自定义回复"
          />
        </RadioGroup>
      )}
      <TextField
        fullWidth
        size="small"
        multiline={!secret}
        type={secret ? 'password' : 'text'}
        required={choice === 'custom'}
        disabled={disabled || choice !== 'custom'}
        label={options.length ? '自定义内容' : '回复内容'}
        value={custom}
        onChange={(event) => {
          setCustom(event.target.value)
          onAnswer(event.target.value)
        }}
      />
    </fieldset>
  )
}

function InteractionForm({
  run,
  interaction,
  events,
  acknowledgments,
}: {
  run: AgentRun
  interaction: Interaction
  events: AgentEvent[]
  acknowledgments: NonNullable<RunRecord['command_acks']>
}) {
  const params = decodeJson<{
    method?: string
    title?: string
    message?: string
    reason?: string
    command?: string
    cwd?: string
    itemId?: string
    options?: string[]
    questions?: {
      id: string
      question: string
      header?: string
      options?: QuestionOption[]
      isSecret?: boolean
    }[]
  }>(interaction.parametersJson)
  const tool = events.findLast((event) => event.tool?.callId === params.itemId)?.tool
  const details = { ...decodeJson(tool?.inputJson || ''), ...params }
  const [value, setValue] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [submitted, setSubmitted] = useState<string>()
  const request = useRef<{ body: string; id: string } | null>(null)
  const rejected = acknowledgments.find(
    (ack) => ack.commandId === submitted && ack.state === 'COMMAND_ACK_STATE_REJECTED',
  )
  async function reply(response: unknown) {
    const body = JSON.stringify(response)
    if (request.current?.body !== body || rejected)
      request.current = { body, id: crypto.randomUUID() }
    setSending(true)
    setError('')
    try {
      await localService.reply(run, interaction.interactionId, response, request.current!.id)
      setSubmitted(request.current!.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '回复失败，请重试。')
    } finally {
      setSending(false)
    }
  }
  const uncertain = acknowledgments.some(
    (ack) => ack.commandId === submitted && ack.errorCode === 'delivery_unknown',
  )
  const disabled = sending || (!!submitted && !rejected)
  const confirm = interaction.method === 'extension_ui_request' && params.method === 'confirm'
  const questions =
    interaction.method === 'item/tool/requestUserInput' ? params.questions : undefined
  return (
    <Paper variant="outlined" className="hub-interaction" aria-label="Agent 交互请求">
      <h3>{interaction.approvalRequired ? 'Agent 请求审批' : params.title || 'Agent 等待回复'}</h3>
      {params.message && <p>{params.message}</p>}
      {interaction.approvalRequired && (
        <div className="hub-interaction-details">
          {params.title && <p>{params.title}</p>}
          {params.reason && <p>{params.reason}</p>}
          {typeof details.command === 'string' && <pre>{details.command}</pre>}
          {params.cwd && (
            <p>
              工作目录：<code>{params.cwd}</code>
            </p>
          )}
          <details>
            <summary>请求详情</summary>
            <pre>{JSON.stringify({ method: interaction.method, ...details }, null, 2)}</pre>
          </details>
        </div>
      )}
      {(error || rejected) && (
        <Alert severity="error">{error || 'Agent 拒绝了该回复。请检查内容后重试。'}</Alert>
      )}
      {submitted && !rejected && (
        <p role="status">
          {uncertain
            ? '回复的投递结果未知，请等待状态更新或停止执行，勿重复提交。'
            : '回复已提交，等待 Agent 继续执行。'}
        </p>
      )}
      {interaction.approvalRequired || confirm ? (
        <div className="hub-interaction-actions">
          <Button
            variant="outlined"
            disabled={disabled}
            onClick={() => {
              void reply(confirm ? { confirmed: false } : { decision: 'decline' })
            }}
          >
            {confirm ? '取消' : '拒绝'}
          </Button>
          <Button
            variant="contained"
            disabled={disabled}
            onClick={() => {
              void reply(confirm ? { confirmed: true } : { decision: 'accept' })
            }}
          >
            {confirm ? '确认' : '批准'}
          </Button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (questions) {
              if (
                questions.some(
                  (question) =>
                    typeof answers[question.id] !== 'string' || !answers[question.id].trim(),
                )
              ) {
                setError('请为每个问题选择选项或填写自定义回复。')
                return
              }
              void reply({
                answers: Object.fromEntries(
                  questions.map((question) => [
                    question.id,
                    { answers: [answers[question.id] || ''] },
                  ]),
                ),
              })
            } else if (params.method === 'select' && !value.trim()) {
              setError('请选择一个选项或填写自定义回复。')
            } else if (interaction.method === 'a2a.message') {
              void reply({ text: value })
            } else if (interaction.method === 'extension_ui_request') {
              void reply({ value })
            } else {
              try {
                void reply(JSON.parse(value))
              } catch {
                setError('请输入有效的 JSON 对象。')
              }
            }
          }}
        >
          {questions ? (
            questions.map((question) => (
              <QuestionInput
                key={question.id}
                title={
                  question.header
                    ? `${question.header}：${question.question}`
                    : question.question || question.id
                }
                options={question.options ?? []}
                secret={question.isSecret}
                disabled={disabled}
                onAnswer={(answer) =>
                  setAnswers((previous) => ({ ...previous, [question.id]: answer }))
                }
              />
            ))
          ) : params.method === 'select' && params.options ? (
            <QuestionInput
              title="回复选项"
              options={params.options.map((label) => ({ label }))}
              disabled={disabled}
              onAnswer={setValue}
            />
          ) : (
            <TextField
              required
              fullWidth
              multiline
              size="small"
              label={
                interaction.method === 'extension_ui_request' ||
                interaction.method === 'a2a.message'
                  ? '回复内容'
                  : '回复 JSON'
              }
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}
          <Button type="submit" variant="contained" disabled={disabled}>
            发送回复
          </Button>
        </form>
      )}
    </Paper>
  )
}
