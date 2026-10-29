/**
 * What a prompt card offers, in Claude Code's TUI wording (2.1.312), and the
 * wire answer behind each row. Pure: the prompt dock renders it.
 *
 * Sources: the TUI's screens for the same requests (CLI spike report, items 1
 * and 2) and, where no screen was captured, the TUI's own row builders. Rows are
 * built from the request's `permission_suggestions`, so they differ per tool:
 *
 *   Yes                                  allow once
 *   directory row / rule row             allow + those suggestions (a directory
 *                                        suggestion wins, as on the TUI)
 *   one row per mode suggestion          allow + that `setMode`
 *   Bash: switch to auto mode            allow + setMode auto (account has auto)
 *   No                                   deny + interrupt (the turn stops)
 *
 * Known gap: the TUI generalises a Bash rule to a prefix (`python3 *`); that
 * prefix never reaches the wire, so chat offers the exact command's rule.
 *
 * @module chat/prompts/prompt-options
 */
import type { PermissionDecision, PermissionRequestEvent } from '@slayzone/terminal-contracts'

/** The CLI's own text for a rejected tool call (and what a bare TUI reject sends). */
export const REJECT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

const FEEDBACK_PREFIX =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n"

/** "No, and tell Claude what to do differently": the tool is rejected, the turn continues. */
export function feedbackDenial(text: string): PermissionDecision {
  return { behavior: 'deny', message: `${FEEDBACK_PREFIX}${text}` }
}

export interface PromptOption {
  /** Stable row id (persisted on `permission-resolved` as `optionId`). */
  id: string
  label: string
  /** The answer this row sends; null for a row that needs typed feedback first. */
  decision: PermissionDecision | null
  /** The row opens a text field; the typed text becomes the answer. */
  needsFeedback?: boolean
}

export interface PermissionView {
  title: string
  /** `from the <name> agent` when a subagent asks. */
  agentLabel?: string
  subtitle?: string
  /** The question above the rows. */
  question: string
  decisionReason?: string
  tip?: string
  options: PromptOption[]
  /** Row selected when the card opens (`default_to_no` → No). */
  defaultIndex: number
  footer?: string
  /** Tab opens "No, and tell Claude what to do differently". */
  canAmend: boolean
  /** Row Shift+Tab picks (the TUI's "switch to accept edits" shortcut). */
  shiftTabOptionId?: string
}

export interface PermissionViewCtx {
  /** The account has auto mode and opted in. */
  autoModeAvailable: boolean
  /** The session's working directory (MCP rule rows name it). */
  cwd: string
  /** Subagent type of the agent that asked, when known. */
  agentName?: string | null
}

/** TUI names of permission modes in "switch to …" rows. */
const MODE_ROW_NAMES: Record<string, string> = {
  default: 'default (ask each time)',
  acceptEdits: 'accept edits (auto-approve file edits and common file commands)',
  auto: 'auto (no routine prompts; a reviewer model screens actions)',
  plan: 'plan mode (research and propose changes without making them)'
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

type Suggestion = Record<string, unknown>

function asSuggestions(v: unknown): Suggestion[] {
  return Array.isArray(v)
    ? v.filter((s): s is Suggestion => s !== null && typeof s === 'object' && !Array.isArray(s))
    : []
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** "a", "a and b", "a, b, and c" — the TUI's list wording. */
function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function rulesOf(s: Suggestion): Array<{ toolName: string; ruleContent?: string }> {
  return Array.isArray(s.rules)
    ? s.rules.filter(
        (r): r is { toolName: string; ruleContent?: string } =>
          r !== null &&
          typeof r === 'object' &&
          typeof (r as { toolName?: unknown }).toolName === 'string'
      )
    : []
}

/** `mcp__server__tool` → [server, tool]. */
function mcpParts(toolName: string): [string, string] | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName)
  return m ? [m[1], m[2]] : null
}

function ruleRowLabel(
  req: PermissionRequestEvent,
  rules: Array<{ toolName: string; ruleContent?: string }>,
  cwd: string
): string {
  if (req.toolName === 'Bash' && rules.length === 1 && rules[0].ruleContent) {
    return `Yes, and don’t ask again for: ${rules[0].ruleContent}`
  }
  if (req.toolName === 'WebFetch') {
    const domains = rules.flatMap((r) =>
      r.ruleContent?.startsWith('domain:') ? [r.ruleContent.slice(7)] : []
    )
    if (domains.length > 0) return `Yes, and don't ask again for ${joinList(domains)}`
  }
  const mcp = mcpParts(req.toolName)
  if (mcp) {
    const server = req.mcpServer?.name ?? mcp[0]
    return `Yes, and don't ask again for ${server} — ${req.displayName ?? mcp[1]} commands in ${cwd}`
  }
  const names = rules.map((r) =>
    r.ruleContent ? r.ruleContent.replace(/(:\*| \*)$/, '') : r.toolName
  )
  return `Yes, and don't ask again for ${joinList(names)} commands in ${cwd}`
}

/** Rows between "Yes" and "No" built from the request's suggestions. */
function suggestionRows(req: PermissionRequestEvent, ctx: PermissionViewCtx): PromptOption[] {
  const suggestions = asSuggestions(req.permissionSuggestions)
  const rows: PromptOption[] = []
  if (!req.suppressAlwaysAllow) {
    const dirs = suggestions.filter(
      (s) =>
        s.type === 'addDirectories' &&
        Array.isArray(s.directories) &&
        (s.destination === 'session' || s.destination === 'localSettings')
    )
    const rules = suggestions.filter(
      (s) =>
        s.type === 'addRules' &&
        s.behavior === 'allow' &&
        rulesOf(s).length > 0 &&
        (s.destination === 'session' || s.destination === 'localSettings')
    )
    if (dirs.length > 0) {
      const paths = dirs.flatMap((s) =>
        (s.directories as unknown[]).filter((d): d is string => typeof d === 'string')
      )
      rows.push({
        id: 'yes-dirs',
        label: `Yes, and always allow access to ${joinList(paths)} from this project`,
        decision: { behavior: 'allow', updatedPermissions: dirs }
      })
    } else if (rules.length > 0) {
      rows.push({
        id: 'yes-rules',
        label: ruleRowLabel(req, rules.flatMap(rulesOf), ctx.cwd),
        decision: { behavior: 'allow', updatedPermissions: rules }
      })
    }
  }
  for (const s of suggestions) {
    if (s.type !== 'setMode' || s.destination !== 'session' || typeof s.mode !== 'string') continue
    const name = MODE_ROW_NAMES[s.mode]
    if (!name) continue
    const shortcut =
      s.mode === 'acceptEdits' && FILE_EDIT_TOOLS.has(req.toolName) ? ' (shift+tab)' : ''
    rows.push({
      id: `yes-mode-${s.mode}`,
      label: `Yes, and switch to ${name} for this session${shortcut}`,
      decision: { behavior: 'allow', updatedPermissions: [s] }
    })
  }
  return rows
}

const AUTO_MODE_UPDATE = { type: 'setMode', mode: 'auto', destination: 'session' }

/** The card for a `can_use_tool` request (not AskUserQuestion / ExitPlanMode). */
export function buildPermissionView(
  req: PermissionRequestEvent,
  ctx: PermissionViewCtx
): PermissionView {
  const input = asRecord(req.input)
  const filePath = str(input.file_path) ?? str(input.notebook_path)
  const fileName = req.description ?? (filePath ? basename(filePath) : undefined)
  const options: PromptOption[] = [{ id: 'yes', label: 'Yes', decision: { behavior: 'allow' } }]
  options.push(...suggestionRows(req, ctx))

  const offersAuto =
    req.toolName === 'Bash' &&
    ctx.autoModeAvailable &&
    !options.some((o) => o.id === 'yes-mode-auto')
  if (offersAuto) {
    options.push({
      id: 'yes-auto',
      label: 'Yes, and switch to auto mode · auto mode handles these prompts for you',
      decision: { behavior: 'allow', updatedPermissions: [AUTO_MODE_UPDATE] }
    })
  }

  const isWebFetch = req.toolName === 'WebFetch'
  options.push(
    isWebFetch
      ? {
          id: 'no-feedback',
          label: 'No, and tell Claude what to do differently (esc)',
          decision: null,
          needsFeedback: true
        }
      : {
          id: 'no',
          label: 'No',
          decision: { behavior: 'deny', message: REJECT_MESSAGE, interrupt: true }
        }
  )

  const view: PermissionView = {
    title: 'Tool use',
    question: 'Do you want to proceed?',
    options,
    defaultIndex: req.defaultToNo ? options.length - 1 : 0,
    canAmend: !isWebFetch,
    ...(isWebFetch ? {} : { footer: 'Esc to cancel · Tab to amend' }),
    ...(req.agentId
      ? { agentLabel: ctx.agentName ? `from the ${ctx.agentName} agent` : 'from a subagent' }
      : {}),
    ...(req.decisionReason ? { decisionReason: req.decisionReason } : {})
  }
  const shiftTab = options.find((o) => o.id === 'yes-mode-acceptEdits')
  if (shiftTab && FILE_EDIT_TOOLS.has(req.toolName)) view.shiftTabOptionId = shiftTab.id

  switch (req.toolName) {
    case 'Bash':
      view.title = 'Bash command'
      if (offersAuto) {
        view.tip =
          'Tip: auto mode handles these prompts for you — choose "switch to auto mode" below'
      }
      break
    case 'Edit':
    case 'MultiEdit':
      view.title = 'Edit file'
      if (fileName) {
        view.subtitle = fileName
        view.question = `Do you want to make this edit to ${fileName}?`
      }
      break
    case 'Write':
      view.title = 'Create file'
      if (fileName) {
        view.subtitle = fileName
        view.question = `Do you want to create ${fileName}?`
      }
      break
    case 'WebFetch': {
      view.title = 'Fetch'
      const url = str(input.url)
      let domain: string | undefined
      try {
        domain = url ? new URL(url).hostname : undefined
      } catch {
        domain = undefined
      }
      if (domain) view.subtitle = `Claude wants to fetch content from ${domain}`
      view.question = 'Do you want to allow Claude to fetch this content?'
      break
    }
    default: {
      const mcp = mcpParts(req.toolName)
      view.subtitle = mcp
        ? `${req.mcpServer?.name ?? mcp[0]} — ${req.displayName ?? mcp[1]} Tool: (MCP)`
        : (req.displayName ?? req.toolName)
    }
  }
  return view
}

/**
 * ExitPlanMode ("Ready to code?"). Approving rides the answer: the mode switch
 * is a session `setMode` update; "manually approve edits" is a plain allow,
 * after which the CLI leaves plan mode for `default` (Ask before edits).
 */
export function buildPlanOptions(ctx: { autoModeAvailable: boolean }): PromptOption[] {
  return [
    ctx.autoModeAvailable
      ? {
          id: 'plan-auto',
          label: 'Yes, and use auto mode',
          decision: { behavior: 'allow', updatedPermissions: [AUTO_MODE_UPDATE] }
        }
      : {
          id: 'plan-accept-edits',
          label: 'Yes, auto-accept edits',
          decision: {
            behavior: 'allow',
            updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
          }
        },
    { id: 'plan-manual', label: 'Yes, manually approve edits', decision: { behavior: 'allow' } },
    {
      id: 'plan-feedback',
      label: 'Tell Claude what to change',
      decision: null,
      needsFeedback: true
    }
  ]
}

/** Question-level notes the user added, keyed by question text (the TUI's `annotations`). */
export type QuestionAnnotations = Record<string, { preview?: string; notes?: string }>

/** Submit an AskUserQuestion: the answers (and notes/previews) ride the tool's input. */
export function questionAnswerDecision(
  input: unknown,
  answers: Record<string, string>,
  annotations: QuestionAnnotations
): PermissionDecision {
  return {
    behavior: 'allow',
    updatedInput: {
      ...asRecord(input),
      answers,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {})
    }
  }
}

/**
 * Cancel on a question. The TUI rejects the tool without feedback, so the
 * model reads the CLI's reject text; chat declines just the question — the
 * turn isn't interrupted and the queue is untouched.
 */
export function declineQuestionDecision(): PermissionDecision {
  return { behavior: 'deny', message: REJECT_MESSAGE }
}

/** "Chat about this": reject with the TUI's text listing what was answered so far. */
export function clarifyDecision(
  questions: Array<{ question: string }>,
  answers: Record<string, string>,
  notes: Record<string, string>
): PermissionDecision {
  const asked = questions
    .map((q) => {
      const lines = [`- "${q.question}"`]
      lines.push(
        answers[q.question] ? `  Answer: ${answers[q.question]}` : '  (No answer provided)'
      )
      if (notes[q.question]) lines.push(`  User notes: ${notes[q.question]}`)
      return lines.join('\n')
    })
    .join('\n')
  return {
    behavior: 'deny',
    message: `The user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n${asked}`
  }
}
