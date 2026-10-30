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
  streamKeyOf,
  type TimelineItem,
  type ToolInvocation
} from '@slayzone/terminal/reducer'

/** Marker texts older builds sent as chat messages (approve / cancel a plan): never shown. */
const PLAN_MARKERS = new Set(['__slay_plan_approved__', '__slay_plan_cancelled__'])

/** The sub-agent launcher (`Agent`, `Task` in older CLIs): shown inside its sub-agent row. */
export function isAgentLauncher(name: string | undefined): boolean {
  return name === 'Agent' || name === 'Task'
}

export function isShown(item: TimelineItem): boolean {
  if (item.parentToolUseId != null) return false
  if (item.kind === 'session-start') return false
  if (item.kind === 'rate-limit' && item.status === 'allowed') return false
  if (item.kind === 'tool' && isAgentLauncher(item.invocation.name)) return false
  if (item.kind === 'user-text' && PLAN_MARKERS.has(item.text)) return false
  return true
}

export interface TimelineRow {
  key: string
  item: TimelineItem
}

/**
 * The rows, oldest first. `openBranches`: the `conversation-branch` dividers opened by
 * the user (their folded rows show); every other fold stays hidden.
 */
export function timelineRows(
  timeline: readonly TimelineItem[],
  openBranches: ReadonlySet<string> = new Set()
): TimelineRow[] {
  const folded = new Set<number>()
  for (const it of timeline) {
    if (it.kind !== 'conversation-branch' || openBranches.has(it.id)) continue
    for (let i = it.hiddenFrom; i < it.hiddenFrom + it.hiddenCount; i++) folded.add(i)
  }
  const rows: TimelineRow[] = []
  timeline.forEach((item, index) => {
    if (!folded.has(index) && isShown(item)) rows.push({ key: rowKey(item, index), item })
  })
  return rows
}

type Branch = Extract<TimelineItem, { kind: 'conversation-branch' }>

/** What a divider says happened (desktop's `ConversationBranchRow`). */
export function branchLabel(item: Branch): string {
  switch (item.reason) {
    case 'rewound':
      return 'Rewound: Claude forgot what came after this point'
    case 'forked':
      return 'Forked into a new conversation'
    case 'fork-failed':
      return 'Fork failed: still the original conversation'
    case 'switched':
      if (item.source === 'terminal') return 'Continued from the terminal'
      return item.title ? `Resumed: ${item.title}` : 'Resumed an earlier conversation'
  }
}

/** The divider's show / hide control; null when it folds nothing. */
export function branchToggleLabel(item: Branch, open: boolean): string | null {
  if (item.hiddenCount <= 0) return null
  const what =
    item.reason === 'switched'
      ? 'previous conversation'
      : item.reason === 'forked'
        ? 'original conversation'
        : 'rewound'
  return open ? `Hide ${what}` : `Show ${what} (${item.hiddenCount})`
}

/** Where a turn ended without a reply (desktop's `InterruptedBlock`). */
export function interruptedLabel(item: Extract<TimelineItem, { kind: 'interrupted' }>): string {
  return item.reason === 'already-in-conversation'
    ? 'Not run again: Claude Code already had this message'
    : 'Turn interrupted'
}

const PRODUCT: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

/**
 * An agent that could not start, in desktop's words (`AgentProblemCard`): what happened
 * and the way out. `inUse`: the terminal runs this conversation, so it can be continued
 * here (`chat.takeOver`).
 */
export function agentProblemText(item: Extract<TimelineItem, { kind: 'agent-problem' }>): {
  title: string
  hint: string
  inUse: boolean
} {
  const inUse = item.code === 'conversation-in-use'
  const name = (item.binary ? PRODUCT[item.binary] : undefined) ?? item.binary ?? 'The agent'
  const title =
    item.code === 'cli-not-installed'
      ? `${name} isn't installed`
      : item.code === 'spawn-refused'
        ? 'The computer refused to start the agent'
        : inUse
          ? 'This conversation is running in the terminal'
          : "The agent couldn't start"
  const hint =
    item.code === 'cli-not-installed'
      ? `Install ${name} on the computer this task runs on (it must be on that computer's PATH), then retry.`
      : inUse
        ? 'One conversation runs in one place at a time. Continue it here (the terminal stops first), or stop it there and retry.'
        : 'Fix the cause below, then retry.'
  return { title, hint, inUse }
}

export function rowKey(item: TimelineItem, index: number): string {
  const streamKey = streamKeyOf(item)
  if (streamKey) return streamKey
  if (item.kind === 'conversation-branch') return item.id
  if (item.kind === 'text' || item.kind === 'thinking') return `${item.kind}:${item.messageId}`
  if (item.kind === 'user-text' && item.id) return `user:${item.id}`
  if (item.kind === 'result') return `result:${item.timestamp}:${index}`
  if (item.kind === 'hook' && item.hookId) return `hook:${item.hookId}`
  if (item.kind === 'notice' && item.id) return `notice:${item.id}`
  if (item.kind === 'sub-agent') return `sub-agent:${item.toolUseId}`
  return `${item.kind}:${index}`
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
    case 'NotebookEdit':
      return {
        title: inv.name,
        summary: shortPath(str(input.file_path) ?? str(input.notebook_path))
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

export function toolBody(inv: ToolInvocation): ToolBody {
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
    case 'MultiEdit':
      return edits(
        (Array.isArray(input.edits) ? input.edits : []).map((e) => [
          rec(e).old_string,
          rec(e).new_string
        ])
      )
    case 'Write':
      return typeof input.content === 'string'
        ? { type: 'text', text: truncate(input.content, MAX_BODY) }
        : null
    case 'TodoWrite':
      return { type: 'todos', todos: todosOf(inv) }
    case 'Bash': {
      const out = resultText(inv)
      const cmd = str(input.command) ?? ''
      return { type: 'text', text: truncate(out ? `$ ${cmd}\n${out}` : `$ ${cmd}`, MAX_BODY) }
    }
    default: {
      const out = resultText(inv)
      if (out) return { type: 'text', text: truncate(out, MAX_BODY) }
      const args = Object.keys(input).length > 0 ? JSON.stringify(inv.input, null, 2) : ''
      return args ? { type: 'text', text: truncate(args, MAX_BODY) } : null
    }
  }
}

/** Background jobs in spawn order (desktop's banner list). */
export function bgShellList(state: ChatTimelineState): BgShell[] {
  return state.bgShellOrder.flatMap((id) => {
    const s = state.bgShells.get(id)
    return s ? [s] : []
  })
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
