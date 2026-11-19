import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Tooltip } from '@mui/material'
import {
  CircleAlert,
  CircleArrowRight,
  CircleCheck,
  CirclePause,
  Clock3,
  LoaderCircle,
  MessageCircleQuestion,
} from 'lucide-react'
import { preferencesService } from '../services/preferences'
import type { AppData } from '../types'

const priority = [
  'waiting',
  'running',
  'failed',
  'ready',
  'completed',
  'paused',
  'pending',
] as const
type Status = (typeof priority)[number]
type Scope = `${'task' | 'spec' | 'requirement'}:${string}`
type Notice = { key: string; origin: Scope; status: Status; detail?: string | null }

const statusDisplay = {
  waiting: { label: '需要你回复', icon: MessageCircleQuestion },
  running: { label: '运行中', icon: LoaderCircle },
  failed: { label: '执行异常', icon: CircleAlert },
  paused: { label: '已停止或暂停', icon: CirclePause },
  pending: { label: '待开始', icon: Clock3 },
  completed: { label: 'Spec 已完成', icon: CircleCheck },
  ready: { label: '可进入下一阶段', icon: CircleArrowRight },
}

function requiresDismissal(status: Status) {
  return status === 'waiting' || status === 'paused' || status === 'failed'
}

function collectNotices({ tasks, workflow }: AppData) {
  const byScope = new Map<Scope, Notice[]>()
  const keys = new Set<string>()
  function add(
    origin: Scope,
    status: Status,
    stamp: unknown,
    scopes: Scope[] = [],
    detail?: string | null,
  ) {
    const key = JSON.stringify([origin, status, stamp])
    if (keys.has(key)) return
    keys.add(key)
    const notice = { key, origin, status, detail }
    for (const scope of [origin, ...scopes]) {
      const group = byScope.get(scope)
      if (group) group.push(notice)
      else byScope.set(scope, [notice])
    }
  }

  const specs = new Map(workflow?.specs.map((spec) => [spec.id, spec]))
  const ready = new Set(workflow?.ready_spec_ids)
  const interactions = new Map<string, string>()
  for (const message of workflow?.messages ?? []) {
    if (message.kind === 'waiting' && message.run_id) interactions.set(message.run_id, message.id)
  }
  for (const task of tasks) {
    const queue = task.queue
    const spec = queue?.spec_id ? specs.get(queue.spec_id) : undefined
    const failure =
      queue?.error ||
      (queue?.result?.outcome === 'failed' && (!queue.spec_id || spec?.round === queue.round)
        ? queue.result.summary || '验收未通过'
        : null)
    const status =
      task.execution === 'waiting'
        ? 'waiting'
        : task.execution === 'executing'
          ? 'running'
          : failure
            ? 'failed'
            : queue?.paused && !spec?.paused
              ? 'paused'
              : queue?.spec_id && task.status === 'todo' && !queue.paused
                ? 'pending'
                : null
    if (!status) continue
    const scopes: Scope[] = []
    if (queue?.spec_id) scopes.push(`spec:${queue.spec_id}`)
    if (status === 'running' || status === 'waiting' || status === 'failed')
      scopes.push(`requirement:${task.requirementId}`)
    const interaction = queue?.run_id && interactions.get(queue.run_id)
    add(
      `task:${task.id}`,
      status,
      status === 'waiting' ? [queue?.attempt, queue?.execution_state, interaction] : queue?.attempt,
      scopes,
      status === 'failed' ? failure : undefined,
    )
  }

  for (const spec of specs.values()) {
    const scope: Scope = `spec:${spec.id}`
    const runs =
      workflow?.execution_runs?.[spec.id] ??
      (workflow?.execution_states?.[spec.id] ?? []).map((state) => ({
        id: spec.document_run_id ?? spec.session_id,
        state,
        interaction_id: null,
      }))
    const revision = [spec.phase, spec.round, spec.document_run_id]
    for (const run of runs) {
      if (run.state === 'waiting_input' || run.state === 'waiting_approval')
        add(scope, 'waiting', [run.id, run.state, run.interaction_id])
      else if (run.state === 'queued' || run.state === 'dispatched' || run.state === 'running')
        add(scope, 'running', run.id)
      else if (run.state === 'failed') add(scope, 'failed', run.id, [], spec.error)
      else if (run.state === 'cancelled' && !spec.error && !spec.paused)
        add(scope, 'paused', run.id)
    }
    const failed = runs.some((run) => run.state === 'failed')
    if (spec.error && !failed) add(scope, 'failed', [revision, spec.error], [], spec.error)
    if (spec.paused && !spec.error && !failed) add(scope, 'paused', null)
    if (ready.has(spec.id)) add(scope, 'ready', revision)
    if (spec.phase === 'complete') add(scope, 'completed', spec.round)
  }
  for (const group of byScope.values())
    group.sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status))
  return { byScope, keys }
}

const NoticeContext = createContext<{
  notices: ReturnType<typeof collectNotices>['byScope']
  seen: ReadonlySet<string>
  dismiss: (key: string) => void
} | null>(null)

export function NodeStatusProvider({
  data,
  viewedTaskId,
  viewedSpecId,
  children,
}: {
  data: AppData
  viewedTaskId?: string | null
  viewedSpecId?: string
  children: ReactNode
}) {
  const { byScope, keys } = useMemo(() => collectNotices(data), [data])
  const [seen, setSeen] = useState(preferencesService.readNodeNotices)
  useEffect(() => {
    if (!data.workflow) return
    function syncSeen() {
      const viewed: Scope[] = []
      if (!document.hidden) {
        if (viewedTaskId) viewed.push(`task:${viewedTaskId}`)
        if (viewedSpecId) viewed.push(`spec:${viewedSpecId}`)
      }
      setSeen((previous) => {
        const next = new Set([...previous].filter((key) => keys.has(key)))
        for (const scope of viewed) {
          for (const notice of byScope.get(scope) ?? []) {
            if (notice.origin === scope && !requiresDismissal(notice.status)) next.add(notice.key)
          }
        }
        return previous.size === next.size && [...next].every((key) => previous.has(key))
          ? previous
          : next
      })
    }
    syncSeen()
    document.addEventListener('visibilitychange', syncSeen)
    return () => document.removeEventListener('visibilitychange', syncSeen)
  }, [byScope, data.workflow, keys, viewedSpecId, viewedTaskId])
  useEffect(() => preferencesService.saveNodeNotices(seen), [seen])

  return (
    <NoticeContext
      value={{
        notices: byScope,
        seen,
        dismiss: (key) => setSeen((previous) => new Set(previous).add(key)),
      }}
    >
      {children}
    </NoticeContext>
  )
}

export function NodeStatus({
  requirementId,
  specId,
  taskId,
  source = false,
}: {
  requirementId?: string
  specId?: string
  taskId?: string
  source?: boolean
}) {
  const context = useContext(NoticeContext)
  if (!context) return null
  const scope: Scope = taskId
    ? `task:${taskId}`
    : specId
      ? `spec:${specId}`
      : `requirement:${requirementId}`
  const items = context.notices.get(scope)
  const available = (notice: Notice) => !context.seen.has(notice.key)
  const own = source && items?.find((notice) => notice.origin === scope && available(notice))
  const notice = own || items?.find(available)
  if (!notice) return null

  const { key, status, detail } = notice
  const { label, icon: StatusIcon } = statusDisplay[status]
  const icon = (
    <StatusIcon
      size={14}
      strokeWidth={1.75}
      className={status === 'running' ? 'spin' : undefined}
      aria-hidden="true"
    />
  )
  const className = `node-status node-status-${status}`
  return own && requiresDismissal(status) ? (
    <Tooltip
      title={detail ? `${label}：${detail} · 点击消除提示` : `${label} · 点击消除提示`}
      describeChild
    >
      <button
        type="button"
        className={`${className} node-status-dismiss`}
        aria-label={`消除${label}提示`}
        data-state={status}
        onClick={() => context.dismiss(key)}
      >
        {icon}
      </button>
    </Tooltip>
  ) : (
    <Tooltip title={detail || label}>
      <span className={className} role="img" aria-label={label} data-state={status}>
        {icon}
      </span>
    </Tooltip>
  )
}
