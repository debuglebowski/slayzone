import type { SessionInfo, TerminalState } from '../shared/types'

interface MergeInputs {
  ptys: ReadonlyArray<{ sessionId: string; state: TerminalState }>
  chats: ReadonlyArray<{ sessionId: string; state: TerminalState }>
}

/**
 * Pure merge of PTY + chat session entries into a discriminated union.
 *
 * Collision policy: PTY takes precedence. A sessionId should never appear
 * in both backends — a tab is either PTY or chat. If we ever see a
 * collision we log + drop the chat dup so the bug surfaces instead of
 * being silently masked.
 *
 * Lives in its own module so tests can exercise it without dragging in
 * electron-bound imports from pty-manager.
 */
export function mergeSessions({ ptys, chats }: MergeInputs): SessionInfo[] {
  const out: SessionInfo[] = []
  const seen = new Set<string>()

  for (const p of ptys) {
    out.push({ sessionId: p.sessionId, state: p.state, kind: 'pty' })
    seen.add(p.sessionId)
  }

  for (const c of chats) {
    if (seen.has(c.sessionId)) {
      console.warn(
        `[session-registry] sessionId collision: ${c.sessionId} present in both PTY and chat managers; dropping chat entry`
      )
      continue
    }
    out.push({ sessionId: c.sessionId, state: c.state, kind: 'chat' })
  }

  return out
}
