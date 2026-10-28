import type { ConversationOrigin } from '@slayzone/terminal-contracts'

/**
 * Agent-session history the terminal container shows (sessions sidebar + its
 * toggle). The data lives in task (`agentSessions.*`), which sits ABOVE
 * task-terminals and renders its `TerminalContainer` — so task-terminals owns
 * this contract and task injects the real hook once via
 * registerTaskSessionsSource() (binding: `@slayzone/task/client/taskSessionsSource`).
 * task-terminals never calls an `agentSessions.*` route itself.
 */

/** One user-facing agent session for a task: a distinct provider conversation. */
export interface TaskSessionRow {
  /** Provider thread id — the session's stable identity. */
  conversationId: string
  /** Provenance of the session's first spawn (fresh / resume / heal / …). */
  origin: ConversationOrigin
  /** Earliest spawn timestamp for this conversation. */
  startedAt: number
  /** Latest spawn timestamp for this conversation (most recent re-spawn/resume). */
  lastActiveAt: number
  /** User prompts captured for this conversation. */
  messageCount: number
  /** Earliest captured user prompt text — the human-readable session label. */
  firstPrompt: string | null
  /** True when this conversation is the honored "current" one (reset-aware). */
  isCurrent: boolean
}

export interface TaskSessionsSource {
  /**
   * Every session tied to a task's main agent (mode `agentId`), newest first.
   * Must refetch when this task's sessions change. `enabled` gates all work
   * (query + subscription) so a task whose sidebar/button is hidden costs nothing.
   */
  useTaskSessions: (taskId: string, agentId: string, enabled: boolean) => readonly TaskSessionRow[]
}

let registered: TaskSessionsSource | null = null

/**
 * Called ONCE by the composing app at module scope, before its first render. The
 * container calls the injected hook, so it must be the same function on every
 * render for the app's lifetime — a module-level registration (not a context,
 * whose value may change) is what makes that hold. Re-registering the same
 * object is a no-op; a different one throws.
 */
export function registerTaskSessionsSource(source: TaskSessionsSource): void {
  if (registered && registered !== source) {
    throw new Error('registerTaskSessionsSource: a task sessions source is already registered')
  }
  registered = source
}

/** Test-only: drop the registration so a test can register its own stub. */
export function resetTaskSessionsSourceForTests(): void {
  registered = null
}

function getTaskSessionsSource(): TaskSessionsSource {
  if (!registered) {
    throw new Error('useTaskSessions: the app must call registerTaskSessionsSource first')
  }
  return registered
}

/** The injected `useTaskSessions` (fixed for the app's lifetime — see registerTaskSessionsSource). */
export function useTaskSessions(
  taskId: string,
  agentId: string,
  enabled: boolean
): readonly TaskSessionRow[] {
  return getTaskSessionsSource().useTaskSessions(taskId, agentId, enabled)
}
