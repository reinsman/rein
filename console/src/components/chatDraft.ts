import { createContext, useContext } from 'react'
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react'
import { localService, waitUntil } from '../services/localService'

export type QueuedFollowup = {
  text: string
  cancel: () => boolean
  posting?: boolean
  error?: string
}
type Draft = { text: string; sending: boolean; queued?: QueuedFollowup }
const emptyDraft: Draft = { text: '', sending: false }
export type ChatDrafts = ReadonlyMap<string, Draft>
export const ChatDraftContext = createContext<
  [ChatDrafts, Dispatch<SetStateAction<ChatDrafts>>] | null
>(null)

function writeDraft(drafts: Map<string, Draft>, key: string, draft: Draft) {
  if (draft.text || draft.sending || draft.queued) drafts.set(key, draft)
  else drafts.delete(key)
}

export function useChatDraft(key: string) {
  const context = useContext(ChatDraftContext)
  if (!context) throw new Error('ChatDraftContext provider is missing')
  const [drafts, setDrafts] = context
  const { text: draft, sending, queued } = drafts.get(key) ?? emptyDraft
  function update(patch: Partial<Draft>) {
    setDrafts((previous) => {
      const next = new Map(previous)
      writeDraft(next, key, { ...(previous.get(key) ?? emptyDraft), ...patch })
      return next
    })
  }
  function finishSend(nextKey = key) {
    setDrafts((previous) => {
      const current = previous.get(key)
      const destination = previous.get(nextKey) ?? emptyDraft
      if (!current?.text) return previous
      const edited = current.text !== draft
      if (edited && (nextKey === key || destination.text)) return previous
      const next = new Map(previous)
      writeDraft(next, key, { ...current, text: '' })
      if (edited) writeDraft(next, nextKey, { ...destination, text: current.text })
      return next
    })
  }
  async function queueFollowup(
    runId: string,
    send: (text: string, requestId: string) => Promise<void>,
    ready?: (signal: AbortSignal) => Promise<boolean>,
  ) {
    if (queued || !draft.trim()) return
    const controller = new AbortController()
    const { signal } = controller
    let posting = false
    const message = {
      text: draft,
      cancel: () => {
        if (posting) return false
        controller.abort()
        return true
      },
    }
    const requestId = crypto.randomUUID()
    update({ text: '', queued: message })
    try {
      await waitUntil(
        async (signal) =>
          (await localService.followupReady(runId, signal)) && (!ready || (await ready(signal))),
        signal,
      )
      signal.throwIfAborted()
      posting = true
      update({ queued: { ...message, posting } })
      await send(message.text.trim(), requestId)
      update({ queued: undefined })
    } catch (failure) {
      posting = false
      if (!signal.aborted)
        update({
          queued: {
            ...message,
            error: failure instanceof Error ? failure.message : '请恢复草稿后重试。',
          },
        })
    }
  }
  function withdrawFollowup() {
    if (!queued?.cancel()) return
    update({ queued: undefined, text: draft ? `${queued.text}\n\n${draft}` : queued.text })
  }
  return {
    draft,
    setDraft: (text: string) => update({ text }),
    sending,
    setSending: (sending: boolean) => update({ sending }),
    finishSend,
    queued,
    queueFollowup,
    withdrawFollowup,
  }
}

export const steerShortcut = /^Mac/.test(navigator.platform) ? '⌘+Enter' : 'Ctrl+Enter'

export function chatEnter(event: KeyboardEvent, active: boolean, sendMode: string) {
  if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.shiftKey || event.altKey)
    return
  const shortcut = event.ctrlKey || event.metaKey
  if (!active && !shortcut && sendMode !== 'Enter 发送') return
  event.preventDefault()
  return active && shortcut ? 'steer' : 'send'
}
