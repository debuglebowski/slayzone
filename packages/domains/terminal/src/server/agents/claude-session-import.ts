/**
 * A Claude Code conversation's history for the chat timeline, from the records
 * of its session file (read on the agent's computer: `claudeSession.read`).
 *
 * Session records are close to the stream-json lines the chat already parses,
 * so assistant blocks, tool results and compaction boundaries go through
 * `claudeCodeAdapter.parseLine`. A user's message is a record the stream never
 * echoes; it becomes a `user-message` marked `history` (answered long ago: never
 * a turn in flight, never re-sent). The CLI's own records — meta notes,
 * compaction summaries, slash-command echoes, interrupt markers — stay out.
 *
 * @module agents/claude-session-import
 */
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { claudeCodeAdapter } from './claude-code-adapter'

/** User-record text the CLI writes for itself, not the user's message. */
const CLI_TEXT = /^\s*(<command-|<local-command-|\[Request interrupted by user)/

function userText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const blocks = content as Array<{ type?: unknown; text?: unknown }>
  if (blocks.some((b) => b?.type === 'tool_result')) return null
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n\n')
  return text || null
}

export function claudeSessionHistory(
  records: ReadonlyArray<Record<string, unknown>>
): AgentEvent[] {
  const events: AgentEvent[] = []
  for (const rec of records) {
    if (rec.isMeta === true || rec.isCompactSummary === true || rec.isSidechain === true) continue
    if (rec.type === 'user') {
      const content = (rec.message as { content?: unknown } | undefined)?.content
      const text = userText(content)
      if (text !== null) {
        if (CLI_TEXT.test(text) || typeof rec.uuid !== 'string') continue
        events.push({ kind: 'user-message', id: rec.uuid, text, history: true })
        continue
      }
      // A tool result: the stream's shape (the session file spells the
      // structured result `toolUseResult`).
      const ev = claudeCodeAdapter.parseLine(
        JSON.stringify({
          type: 'user',
          message: rec.message,
          parent_tool_use_id: null,
          ...(rec.toolUseResult !== undefined ? { tool_use_result: rec.toolUseResult } : {})
        })
      )
      if (ev && ev.kind === 'tool-result') events.push(ev)
      continue
    }
    if (rec.type === 'assistant' || (rec.type === 'system' && rec.subtype === 'compact_boundary')) {
      const ev = claudeCodeAdapter.parseLine(JSON.stringify({ ...rec, parent_tool_use_id: null }))
      if (ev && ev.kind !== 'unknown') events.push(ev)
    }
  }
  return events
}
