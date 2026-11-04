/**
 * Chats in this renderer still coming up: loading their history, their agent not
 * asked to start yet.
 *
 * A restored chat loads its history first and only then asks the computer to start
 * its agent (`useChatLifecycle`). From that request on, the hub reports the agent
 * (`pty.onAgentStarts`); before it, only this counter knows the chat is still on its
 * way. The sidebar's startup card reads it, so startup does not look finished while
 * a chat with a long history is still loading.
 */

const loading = new Set<object>()
const listeners = new Set<() => void>()

const changed = (): void => {
  for (const cb of [...listeners]) cb()
}

/** This chat is loading. Returns its release (idempotent). */
export function trackChatLoading(): () => void {
  const token = {}
  loading.add(token)
  changed()
  return () => {
    if (loading.delete(token)) changed()
  }
}

export function chatsLoadingCount(): number {
  return loading.size
}

/** Notified whenever `chatsLoadingCount()` changes. */
export function subscribeChatsLoading(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
