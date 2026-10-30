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
}

const holders = new Map<ConversationSide, ConversationHolder>()

/** Register a side (once, at module load; a later call replaces it). */
export function registerConversationHolder(
  side: ConversationSide,
  holder: ConversationHolder
): void {
  holders.set(side, holder)
}

export function isConversationLive(
  side: ConversationSide,
  taskId: string,
  conversationId: string
): boolean {
  return holders.get(side)?.isLive(taskId, conversationId) ?? false
}

export async function releaseConversation(
  side: ConversationSide,
  taskId: string,
  conversationId: string
): Promise<void> {
  await holders.get(side)?.release(taskId, conversationId)
}

/** What a refused start says: the other side runs this conversation. */
export function conversationInUseMessage(runningIn: ConversationSide): string {
  return runningIn === 'terminal'
    ? 'This conversation is running in the terminal. Continue it here (the terminal stops first), or stop it there.'
    : 'This conversation is running in the chat. Continue it here (the chat stops first), or stop it there.'
}
