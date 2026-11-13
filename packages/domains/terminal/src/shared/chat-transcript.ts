/**
 * A chat conversation as plain text rows — what `slay chat read` prints. Built
 * from the same reducer the chat panel renders (`chat-timeline.ts`), so edits,
 * pops and rewinds read exactly as the panel shows them: rows a rewind folded
 * away are left out.
 *
 * @module terminal/shared/chat-transcript
 */
import type { AgentEvent } from '@slayzone/terminal-contracts'
import {
  initialState,
  reducer,
  selectFoldedIndexes,
  type ChatTimelineState,
  type TimelineItem
} from './chat-timeline'

export type ChatTranscriptRole = 'user' | 'assistant' | 'thinking' | 'tool' | 'status'

export interface ChatTranscriptRow {
  /** Position in the conversation's timeline — stable, so `since` can resume from it. */
  row: number
  role: ChatTranscriptRole
  text: string
  /** A user message's id — what fork / rewind take. */
  messageId?: string
}

export interface ChatTranscriptOptions {
  /** Only rows after this one (exclusive). */
  since?: number
  /** Only the last N rows (after `since`). */
  last?: number
  /** Also thinking, tool results, notices and stderr. */
  verbose?: boolean
}

const RESULT_PREVIEW_CHARS = 400

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** The one input field that says what a tool call does, else its compact JSON. */
function toolSummary(name: string, input: unknown): string {
  if (typeof input === 'string') return `${name}: ${input}`
  const o = asRecord(input)
  for (const key of [
    'command',
    'file_path',
    'notebook_path',
    'path',
    'pattern',
    'url',
    'query',
    'description',
    'prompt'
  ]) {
    const v = o[key]
    if (typeof v === 'string' && v !== '') return `${name}: ${v}`
  }
  if (Array.isArray(o.command)) return `${name}: ${o.command.join(' ')}`
  const json = JSON.stringify(input ?? {})
  return json === '{}' ? name : `${name}: ${json}`
}

function resultText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw))
    return raw
      .map((b) => {
        const block = asRecord(b)
        return typeof block.text === 'string' ? block.text : ''
      })
      .filter(Boolean)
      .join('\n')
  return raw == null ? '' : JSON.stringify(raw)
}

function preview(text: string): string {
  const t = text.trim()
  return t.length > RESULT_PREVIEW_CHARS ? `${t.slice(0, RESULT_PREVIEW_CHARS)}…` : t
}

function rowOf(item: TimelineItem, verbose: boolean): Omit<ChatTranscriptRow, 'row'> | null {
  switch (item.kind) {
    case 'user-text':
      return { role: 'user', text: item.text, ...(item.id ? { messageId: item.id } : {}) }
    case 'text':
      return item.text.trim() ? { role: 'assistant', text: item.text } : null
    case 'thinking':
      return verbose && item.text.trim() ? { role: 'thinking', text: item.text } : null
    case 'tool': {
      const inv = item.invocation
      let text = toolSummary(inv.name, inv.input)
      if (inv.status === 'denied' || inv.denied) text += '\n  → denied'
      else if (verbose && inv.result) {
        const out = preview(resultText(inv.result.rawContent))
        text += inv.result.isError ? `\n  → error: ${out}` : out ? `\n  → ${out}` : ''
      }
      return { role: 'tool', text }
    }
    case 'result':
      return {
        role: 'status',
        text: item.isError ? `turn failed${item.text ? `: ${item.text}` : ''}` : 'turn done'
      }
    case 'turn-error':
      return { role: 'status', text: `turn failed: ${item.text}` }
    case 'agent-problem':
      return { role: 'status', text: `agent problem: ${item.message}` }
    case 'interrupted':
      return {
        role: 'status',
        text:
          item.reason === 'watchdog'
            ? 'interrupted by watchdog'
            : item.reason === 'stop-request'
              ? 'stopped by request'
              : 'interrupted'
      }
    case 'compaction':
      return {
        role: 'status',
        text:
          item.outcome === 'compacted'
            ? 'conversation compacted'
            : `compaction failed${item.error ? `: ${item.error}` : ''}`
      }
    case 'notice':
      return verbose ? { role: 'status', text: item.text } : null
    case 'stderr':
      return verbose ? { role: 'status', text: `stderr: ${item.text}` } : null
    default:
      return null
  }
}

/** The transcript rows of a reduced conversation. */
export function transcriptRows(
  state: ChatTimelineState,
  opts: ChatTranscriptOptions
): ChatTranscriptRow[] {
  const folded = selectFoldedIndexes(state.timeline)
  const rows: ChatTranscriptRow[] = []
  state.timeline.forEach((item, row) => {
    if (!item || folded.has(row) || item.parentToolUseId) return
    if (opts.since !== undefined && row <= opts.since) return
    const r = rowOf(item, opts.verbose === true)
    if (r) rows.push({ row, ...r })
  })
  return opts.last !== undefined && opts.last >= 0
    ? rows.slice(Math.max(0, rows.length - opts.last))
    : rows
}

/** Reduce a saved history (oldest first) and render it. */
export function chatTranscriptFromEvents(
  events: readonly AgentEvent[],
  opts: ChatTranscriptOptions = {},
  reducerOpts: { agentStartedTurns?: boolean } = {}
): ChatTranscriptRow[] {
  const state = reducer(initialState(reducerOpts), { type: 'events', events: [...events] })
  return transcriptRows(state, opts)
}

const PREFIX: Record<ChatTranscriptRole, string> = {
  user: '> ',
  assistant: '',
  thinking: '~ ',
  tool: '• ',
  status: '-- '
}

/** Plain text: a blank line between rows, continuation lines indented under user rows. */
export function formatChatTranscript(rows: readonly ChatTranscriptRow[]): string {
  if (rows.length === 0) return ''
  return `${rows
    .map((r) => {
      const prefix = PREFIX[r.role]
      const indent = r.role === 'user' ? '  ' : ''
      return prefix + r.text.trim().split('\n').join(`\n${indent}`)
    })
    .join('\n\n')}\n`
}
