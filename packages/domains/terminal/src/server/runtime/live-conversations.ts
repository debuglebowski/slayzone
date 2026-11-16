/**
 * Which conversations a live agent process is running, per side — chat tabs and
 * terminal sessions — so one side never starts a second process on a
 * conversation the other side runs (chat A, plan 3.10). Claude chat and the
 * Claude TUI share session files: two processes on one conversation would write
 * one file from two places.
 *
 * Each side registers what it knows (is a conversation live? stop it and wait),
 * and asks the other side through here. A module of its own because the two
 * runtimes cannot import each other: `pty-manager` already imports the chat
 * transport.
 *
 * @module terminal/server/runtime/live-conversations
 */

export type ConversationSide = 'chat' | 'terminal'

export interface ConversationHolder {
  /** A live process of this side runs `conversationId` for `taskId`. */
  isLive(taskId: string, conversationId: string): boolean
  /** Stop every process of this side running it, and wait for their exits. */
  release(taskId: string, conversationId: string): Promise<void>
  /** The session id (`taskId:tabId`) of a live process running it, if any. */
  liveSessionId?(taskId: string, conversationId: string): string | null
  /** Every conversation a live process of this side runs for `taskId`. */
  liveConversations?(taskId: string): string[]
}

export function createConversationRegistry() {
  const holders = new Map<ConversationSide, ConversationHolder>()

  /** Register a side (once, at module load; a later call replaces it). */
  function registerConversationHolder(side: ConversationSide, holder: ConversationHolder): void {
    holders.set(side, holder)
  }

  function isConversationLive(
    side: ConversationSide,
    taskId: string,
    conversationId: string
  ): boolean {
    return holders.get(side)?.isLive(taskId, conversationId) ?? false
  }

  async function releaseConversation(
    side: ConversationSide,
    taskId: string,
    conversationId: string
  ): Promise<void> {
    await holders.get(side)?.release(taskId, conversationId)
  }

  function liveConversationSession(
    side: ConversationSide,
    taskId: string,
    conversationId: string
  ): string | null {
    return holders.get(side)?.liveSessionId?.(taskId, conversationId) ?? null
  }

  /**
   * The conversations a live process of `side` runs for `taskId`: `[]` with no
   * holder (nothing of that side runs here), `null` when its holder cannot list
   * them (the caller must assume any may be live).
   */
  function liveConversations(side: ConversationSide, taskId: string): string[] | null {
    const holder = holders.get(side)
    if (!holder) return []
    return holder.liveConversations ? holder.liveConversations(taskId) : null
  }

  return {
    registerConversationHolder,
    isConversationLive,
    releaseConversation,
    liveConversationSession,
    liveConversations
  }
}
export type ConversationRegistry = ReturnType<typeof createConversationRegistry>
export const defaultConversationRegistry = createConversationRegistry()
export const {
  registerConversationHolder,
  isConversationLive,
  releaseConversation,
  liveConversationSession,
  liveConversations
} = defaultConversationRegistry

/** What a refused start says: the other side runs this conversation. */
export function conversationInUseMessage(runningIn: ConversationSide): string {
  return runningIn === 'terminal'
    ? 'This conversation is running in the terminal. Continue it here (the terminal stops first), or stop it there.'
    : 'This conversation is running in the chat. Continue it here (the chat stops first), or stop it there.'
}

/** What a refused start or pick says: another terminal tab of the task runs this
 *  conversation. Names the tab so the user knows where to stop it. */
export function conversationInOtherTabMessage(tabName: string): string {
  return `This session is running in the "${tabName}" tab. Stop it there first, or start a new session here.`
}
