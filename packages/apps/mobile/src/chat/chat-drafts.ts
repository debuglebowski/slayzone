import type { ChatAttachment } from '@slayzone/terminal-contracts'
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'

type DraftContent = { text: string; attachments: readonly ChatAttachment[] }
type DraftSnapshot = DraftContent & { revision: number }

const empty: DraftContent = { text: '', attachments: [] }

class ChatDraft {
  private snapshot: DraftSnapshot = { ...empty, revision: 0 }
  private listeners = new Set<() => void>()

  read = (): DraftSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  update = (content: Partial<DraftContent>): void => {
    this.snapshot = { ...this.snapshot, ...content, revision: this.snapshot.revision + 1 }
    for (const listener of this.listeners) listener()
  }

  clear = (): void => this.update(empty)
}

/** Session-only drafts, isolated by hub and chat. A detached send still sees newer edits. */
export class ChatDraftStore {
  private hubs = new Map<string, Map<string, ChatDraft>>()

  forChat(hubId: string, chatKey: string): ChatDraft {
    let drafts = this.hubs.get(hubId)
    if (!drafts) {
      drafts = new Map()
      this.hubs.set(hubId, drafts)
    }
    let draft = drafts.get(chatKey)
    if (!draft) {
      draft = new ChatDraft()
      drafts.set(chatKey, draft)
    }
    return draft
  }

  forget(hubId: string): void {
    this.hubs.delete(hubId)
  }
}

export const ChatDraftContext = createContext<ChatDraftStore | null>(null)

export function useChatDraft(hubId: string | null, chatKey: string) {
  const store = useContext(ChatDraftContext)
  const draft = useMemo(
    () => (store && hubId ? store.forChat(hubId, chatKey) : new ChatDraft()),
    [store, hubId, chatKey]
  )
  return { draft, snapshot: useSyncExternalStore(draft.subscribe, draft.read) }
}
