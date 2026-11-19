import { useState } from 'react'
import type { ReactNode } from 'react'
import { ChatDraftContext, type ChatDrafts } from './chatDraft'

export function ChatDraftProvider({ children }: { children: ReactNode }) {
  const drafts = useState<ChatDrafts>(() => new Map())
  return <ChatDraftContext value={drafts}>{children}</ChatDraftContext>
}
