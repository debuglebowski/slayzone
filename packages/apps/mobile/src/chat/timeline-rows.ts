import { CODEX_FILE_CHANGE_TOOL, codexFileChanges } from '@slayzone/terminal/codex-file-changes'
/**
 * What the chat timeline shows of the reducer's items, as plain data: which items are
 * rows (desktop's `isRenderable` + root-only rule, `task-terminals` renderers; what a
 * rewind / fork / switch left the conversation without stays folded behind its
 * `conversation-branch` divider until opened, desktop's `useChatDisplay`), each row's
 * stable key (desktop's `itemKey`: a streaming row keeps its key from first fragment to
 * final text), the dividers' words, and the one-line summary + body of a compact tool card.
 */
import {
  type BgShell,
  type ChatTimelineState,
  selectBackgroundJobs,
  selectFoldedIndexes,
  type TimelineItem,
  type TimelineRows,
  type ToolInvocation
} from '@slayzone/terminal/reducer'
import { chatBlobJsonReplacer } from '@slayzone/terminal-contracts'
import { isRenderable, stableAnchorKey } from '@slayzone/terminal/chat-presentation'
import { type ActivityTurn, activityView } from '@slayzone/terminal/chat-activity'

export function isShown(item: TimelineItem): boolean {
  return item.parentToolUseId == null && isRenderable(item)
}

export interface TimelineRow {
  key: string
  item: TimelineItem
  /** The turn this row hosts (`activityView`): its work shows under the row. */
  turn?: ActivityTurn
}

/**
 * The rows, oldest first. `openBranches`: the `conversation-branch` dividers opened by
 * the user (their folded rows show); every other fold stays hidden.
 */
export function timelineRows(
  timeline: Readonly<TimelineRows>,
  openBranches: ReadonlySet<string> = new Set()
): TimelineRow[] {
  const folded = selectFoldedIndexes(timeline, openBranches)
  const rows: TimelineRow[] = []
  timeline.forEach((item, index) => {
    if (item && !folded.has(index) && isShown(item)) rows.push({ key: rowKey(item, index), item })
  })
  return rows
}

/**
 * The rows with each turn's work folded into the row hosting it (desktop's grouped
 * chat, `activityView`): a turn shows its user message, its answer and, under the
 * answer (or the row it is at so far), its activities. `inFlight`: a turn runs.
 */
export function turnRows(
  timeline: Readonly<TimelineRows>,
  openBranches: ReadonlySet<string> = new Set(),
  inFlight = false
): TimelineRow[] {
  const rows = timelineRows(timeline, openBranches)
  const keys = new Map(rows.map((row) => [row.item, row.key]))
  const view = activityView(
    rows.map((row) => row.item),
    inFlight
  )
  return view.rows.flatMap((item) => {
    const key = keys.get(item)
    if (key === undefined) return []
    const turn = view.turns.get(item)
    return [turn ? { key, item, turn } : { key, item }]
  })
}

export {
  agentProblemText,
  branchLabel,
  branchToggleLabel,
  interruptedLabel
} from '@slayzone/terminal/chat-presentation'

export function rowKey(item: TimelineItem, index: number): string {
  if (item.kind === 'conversation-branch') return item.id
  if (item.kind === 'result') return `result:${item.timestamp}:${index}`
  return stableAnchorKey(item) ?? `${item.kind}:${index}`
}

/** A sub-agent's own items (rendered inside its row), in order. */
export function subAgentItems(
  state: Pick<ChatTimelineState, 'childIndex' | 'timeline'>,
  toolUseId: string
): TimelineItem[] {
  return (state.childIndex.get(toolUseId) ?? []).flatMap((i) => {
    const item = state.timeline[i]
    return item ? [item] : []
  })
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** `/a/b/c/file.ts` → `c/file.ts`: enough to recognize, short enough for a phone. */
export function shortPath(p: string | undefined): string {
  if (!p) return ''
  const parts = p.split('/').filter(Boolean)
  return parts.length <= 2 ? p : parts.slice(-2).join('/')
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`
}

/** `mcp__server__tool` → `server — tool`. */
function mcpTitle(name: string): string | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1]} — ${m[2]}` : null
}

export interface ToolSummary {
  title: string
  summary: string
}

/** The card's header: the tool and what it works on. */
export function toolSummary(inv: ToolInvocation): ToolSummary {
  const input = rec(inv.input)
  const structured = rec(inv.result?.structured)
  switch (inv.name) {
    case 'Bash':
      return {
        title: 'Bash',
        summary: truncate(str(input.description) ?? str(input.command) ?? '', 80)
      }
    case 'Read': {
      const limit = typeof input.limit === 'number' ? input.limit : null
      const offset = typeof input.offset === 'number' ? input.offset : 1
      const lines = limit ? ` · L${offset}–${offset + limit - 1}` : ''
      return { title: 'Read', summary: `${shortPath(str(input.file_path))}${lines}` }
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const file = inv.toolPreview?.files?.[0]
      const path = shortPath(str(input.file_path) ?? str(input.notebook_path) ?? file?.path)
      const counts =
        file && file.additions !== null && file.deletions !== null
          ? ` · +${file.additions} −${file.deletions}`
          : ''
      return { title: inv.name, summary: `${path}${counts}` }
    }
    case CODEX_FILE_CHANGE_TOOL: {
      const changes = codexFileChanges(inv)
      const path = changes.length === 1 ? shortPath(changes[0].path) : `${changes.length} files`
      const files = inv.toolPreview?.files
      const counts = files?.length
        ? ` · +${files.reduce((n, f) => n + (f.additions ?? 0), 0)} −${files.reduce((n, f) => n + (f.deletions ?? 0), 0)}`
        : ''
      return { title: 'Edit', summary: `${path}${counts}` }
    }
    case 'Glob': {
      const n = typeof structured.numFiles === 'number' ? ` → ${structured.numFiles} files` : ''
      return { title: 'Glob', summary: `${str(input.pattern) ?? ''}${n}` }
    }
    case 'Grep': {
      const n =
        structured.mode === 'content' && typeof structured.numLines === 'number'
          ? ` → ${structured.numLines} lines`
          : typeof structured.numFiles === 'number'
            ? ` → ${structured.numFiles} files`
            : ''
      return { title: 'Grep', summary: `${str(input.pattern) ?? ''}${n}` }
    }
    case 'WebFetch':
      return { title: 'Fetch', summary: str(input.url) ?? '' }
    case 'WebSearch':
      return { title: 'Search', summary: str(input.query) ?? '' }
    case 'TodoWrite': {
      const todos = todosOf(inv)
      const doing = todos.find((t) => t.status === 'in_progress')
      return {
        title: 'Todos',
        summary: `${todos.length} todos${doing ? ` · ${doing.content}` : ''}`
      }
    }
    default: {
      const mcp = mcpTitle(inv.name)
      if (mcp) return { title: mcp, summary: '' }
      const target =
        str(input.file_path) ??
        str(input.path) ??
        str(input.command) ??
        str(input.pattern) ??
        str(input.url) ??
        str(input.query) ??
        str(input.description)
      return { title: inv.name, summary: truncate(target ?? '', 80) }
    }
  }
}

export interface Todo {
  content: string
  status: string
}

export function todosOf(inv: ToolInvocation): Todo[] {
  const fromResult = rec(inv.result?.structured).newTodos
  const fromInput = rec(inv.input).todos
  const list = Array.isArray(fromResult) ? fromResult : Array.isArray(fromInput) ? fromInput : []
  return list.flatMap((t) => {
    const r = rec(t)
    return typeof r.content === 'string'
      ? [{ content: r.content, status: String(r.status ?? '') }]
      : []
  })
}

/** The text of a tool result (`tool_result` content: a string or text blocks). */
export function resultText(inv: ToolInvocation): string {
  const raw = inv.result?.rawContent
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    return raw
      .map((b) => (typeof b === 'string' ? b : (str(rec(b).text) ?? '')))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** What an expanded card shows, as lines: `-`/`+` for edits, else the call's output. */
export type ToolBody =
  | { type: 'diff'; lines: Array<{ sign: '-' | '+'; text: string }> }
  | { type: 'text'; text: string }
  | { type: 'todos'; todos: Todo[] }
  | null

const MAX_BODY = 4_000

export function toolBody(inv: ToolInvocation, full = false): ToolBody {
  const textBody = (text: string): ToolBody => ({
    type: 'text',
    text: full ? text : truncate(text, MAX_BODY)
  })
  const input = rec(inv.input)
  const edits = (pairs: Array<[unknown, unknown]>): ToolBody => ({
    type: 'diff',
    lines: pairs.flatMap(([o, n]) => [
      ...(typeof o === 'string' ? o.split('\n').map((text) => ({ sign: '-' as const, text })) : []),
      ...(typeof n === 'string' ? n.split('\n').map((text) => ({ sign: '+' as const, text })) : [])
    ])
  })
  switch (inv.name) {
    case 'Edit':
      return edits([[input.old_string, input.new_string]])
    case CODEX_FILE_CHANGE_TOOL: {
      const changes = codexFileChanges(inv)
      return changes.length
        ? textBody(changes.map((change) => `${change.path}\n${change.diff}`).join('\n\n'))
        : null
    }
    case 'MultiEdit':
      return edits(
        (Array.isArray(input.edits) ? input.edits : []).map((e) => [
          rec(e).old_string,
          rec(e).new_string
        ])
      )
    case 'Write':
      return typeof input.content === 'string' ? textBody(input.content) : null
    case 'TodoWrite':
      return { type: 'todos', todos: todosOf(inv) }
    case 'Bash': {
      const out = resultText(inv)
      const cmd = str(input.command) ?? ''
      return textBody(out ? `$ ${cmd}\n${out}` : `$ ${cmd}`)
    }
    default: {
      const out = resultText(inv)
      if (out) return textBody(out)
      // Stored images / files (`chat-blobs`) print as `[image/png · 120 KB]`.
      const args =
        Object.keys(input).length > 0 ? JSON.stringify(inv.input, chatBlobJsonReplacer, 2) : ''
      return args ? textBody(args) : null
    }
  }
}

/** Background jobs in spawn order (desktop's banner list): not the open turn's own. */
export function bgShellList(state: ChatTimelineState): readonly BgShell[] {
  return selectBackgroundJobs(state)
}

export const BG_STATUS_LABELS: Record<BgShell['status'], string> = {
  pending: 'Starting',
  running: 'Running',
  completed: 'Completed',
  killed: 'Killed',
  failed: 'Failed',
  unknown: 'Unknown'
}

export function isActiveShell(s: BgShell): boolean {
  return s.status === 'pending' || s.status === 'running'
}

/** `42s`, `3m`, `2h` (desktop's banner ages). */
export function formatAge(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  return `${Math.round(min / 60)}h`
}
