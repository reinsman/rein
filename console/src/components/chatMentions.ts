import { createContext, useCallback, useEffect, useMemo, useState } from 'react'
import { preferencesService } from '../services/preferences'
import { workflowService } from '../services/workflow'

export const runMentionKey = (runId: string, itemId: string) =>
  'mention:' + JSON.stringify(['run', runId, itemId])

export const taskMentionKey = (messageId: string) =>
  'mention:' + JSON.stringify(['task-message', messageId])

export function mentionsIn(text: string) {
  return text.matchAll(/(?<![A-Za-z0-9_.+/@-])@([\p{L}\p{N}_-]+)/gu)
}

export function mentionsUser(name: string, userName: string) {
  return name === '用户' || name === userName
}

export function useMentionReads(readKeys?: string[]) {
  const [pending, setPending] = useState(
    () =>
      new Set(
        [...preferencesService.readNodeNotices()].filter((key) => key.startsWith('mention:')),
      ),
  )
  const [saved, setSaved] = useState<Set<string>>(() => new Set())
  const seen = useMemo(() => new Set([...(readKeys ?? []), ...saved]), [readKeys, saved])
  const observed = useMemo(() => new Set([...seen, ...pending]), [seen, pending])
  const canSave = readKeys !== undefined

  const markRead = useCallback((key: string) => {
    setPending((previous) => (previous.has(key) ? previous : new Set(previous).add(key)))
  }, [])
  useEffect(() => {
    if (!canSave || !pending.size) return
    const batch = [...pending].slice(0, 128)
    let active = true
    let retry: ReturnType<typeof setTimeout> | undefined
    async function save() {
      try {
        const { keys } = await workflowService.readChatMentions(batch)
        preferencesService.clearMigratedMentionReads(batch)
        if (!active) return
        setSaved((previous) => new Set([...previous, ...keys]))
        setPending((previous) => {
          const remaining = new Set(previous)
          for (const key of batch) remaining.delete(key)
          return remaining
        })
      } catch {
        if (active) retry = setTimeout(save, 2000)
      }
    }
    void save()
    return () => {
      active = false
      clearTimeout(retry)
    }
  }, [canSave, pending])
  return { seen, observed, markRead }
}

export const ChatMentionContext = createContext<{
  userName: string
  agents: ReadonlySet<string>
  unreadScopes: ReadonlySet<string>
  seen: ReadonlySet<string>
  markRead: (key: string) => void
} | null>(null)
