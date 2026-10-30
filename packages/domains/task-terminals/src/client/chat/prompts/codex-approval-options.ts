/**
 * Codex approvals (codex app-server ≥0.159): the card for each server request
 * the chat driver turns into a `permission-request` (toolName = the JSON-RPC
 * method, input = its params). Rows follow the request's `availableDecisions`
 * (Codex's own choice of what to offer); a request without it gets all four.
 * The answer is a `PermissionDecision` the driver maps back (contract X1 → X2):
 *
 *   Yes                                   {allow}                           accept
 *   Yes, … this session                   {allow, scope: 'session'}         acceptForSession
 *   Yes, … commands that start with `x`   {allow, amendment: execpolicy}    acceptWithExecpolicyAmendment
 *   Yes, and always allow <host>          {allow, amendment: network}       applyNetworkPolicyAmendment
 *   No                                    {deny}                            decline (the turn goes on)
 *   No, and tell Codex … (esc)            {deny, interrupt: true}           cancel (the turn stops)
 *
 * Legacy `execCommandApproval` / `applyPatchApproval` take the same answers
 * (the driver sends their ReviewDecision words).
 *
 * @module chat/prompts/codex-approval-options
 */
import type { PermissionDecision, PermissionRequestEvent } from '@slayzone/terminal-contracts'
import { unwrapShellCommand } from '../tool-cards/codex-items'
import type { PermissionView, PermissionViewCtx, PromptOption } from './prompt-options'

export const CODEX_COMMAND_APPROVAL = 'item/commandExecution/requestApproval'
export const CODEX_FILE_APPROVAL = 'item/fileChange/requestApproval'
export const CODEX_LEGACY_COMMAND_APPROVAL = 'execCommandApproval'
export const CODEX_LEGACY_PATCH_APPROVAL = 'applyPatchApproval'
export const CODEX_PERMISSIONS_APPROVAL = 'item/permissions/requestApproval'
export const CODEX_ELICITATION = 'mcpServer/elicitation/request'

const COMMAND_METHODS = new Set([CODEX_COMMAND_APPROVAL, CODEX_LEGACY_COMMAND_APPROVAL])
const FILE_METHODS = new Set([CODEX_FILE_APPROVAL, CODEX_LEGACY_PATCH_APPROVAL])

/** A Codex request the approval card answers. */
export function isCodexApproval(toolName: string): boolean {
  return (
    COMMAND_METHODS.has(toolName) ||
    FILE_METHODS.has(toolName) ||
    toolName === CODEX_PERMISSIONS_APPROVAL ||
    toolName === CODEX_ELICITATION
  )
}

export function isCodexCommandApproval(toolName: string): boolean {
  return COMMAND_METHODS.has(toolName)
}

export function isCodexFileApproval(toolName: string): boolean {
  return FILE_METHODS.has(toolName)
}

type Allow = Extract<PermissionDecision, { behavior: 'allow' }>

const allow = (extra: Omit<Allow, 'behavior'> = {}): PermissionDecision => ({
  behavior: 'allow',
  ...extra
})
const DECLINE: PermissionDecision = { behavior: 'deny', message: '' }
const CANCEL: PermissionDecision = { behavior: 'deny', message: '', interrupt: true }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** The command a command approval asks about, without its shell wrapper. */
export function codexApprovalCommand(input: unknown): string {
  const params = isRecord(input) ? input : {}
  const raw = params.command
  if (typeof raw === 'string' || Array.isArray(raw)) {
    return unwrapShellCommand(raw as string | string[])
  }
  return ''
}

const ALL_DECISIONS: unknown[] = ['accept', 'acceptForSession', 'decline', 'cancel']

function decisionRows(
  params: Record<string, unknown>,
  isFile: boolean,
  agent: string
): PromptOption[] {
  const available = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : ALL_DECISIONS
  const rows: PromptOption[] = []
  for (const d of available) {
    if (d === 'accept') rows.push({ id: 'yes', label: 'Yes', decision: allow() })
    else if (d === 'acceptForSession') {
      rows.push({
        id: 'yes-session',
        label: isFile
          ? "Yes, and don't ask again for these files this session"
          : "Yes, and don't ask again for this command this session",
        decision: allow({ scope: 'session' })
      })
    } else if (d === 'decline') rows.push({ id: 'no', label: 'No', decision: DECLINE })
    else if (d === 'cancel') {
      rows.push({
        id: 'cancel',
        label: `No, and tell ${agent} what to do differently (esc)`,
        decision: CANCEL
      })
    } else if (isRecord(d) && isRecord(d.acceptWithExecpolicyAmendment)) {
      const command = d.acceptWithExecpolicyAmendment.execpolicy_amendment
      if (!Array.isArray(command)) continue
      const words = command.filter((w): w is string => typeof w === 'string')
      rows.push({
        id: 'yes-execpolicy',
        label: `Yes, and don't ask again for commands that start with \`${words.join(' ')}\``,
        decision: allow({ amendment: { kind: 'execpolicy', command: words } })
      })
    } else if (isRecord(d) && isRecord(d.applyNetworkPolicyAmendment)) {
      const amendment = d.applyNetworkPolicyAmendment.network_policy_amendment
      if (!isRecord(amendment)) continue
      const host = str(amendment.host)
      const action = amendment.action === 'deny' ? 'deny' : 'allow'
      if (!host) continue
      rows.push({
        id: `network-${action}`,
        label:
          action === 'allow' ? `Yes, and always allow ${host}` : `No, and always block ${host}`,
        // Applying the rule is the answer (a block rule: the command doesn't run).
        decision: allow({ amendment: { kind: 'network', host, action } })
      })
    }
  }
  // Esc picks the last row: keep the turn-stopping one there.
  const cancelAt = rows.findIndex((r) => r.id === 'cancel')
  if (cancelAt >= 0 && cancelAt !== rows.length - 1) rows.push(...rows.splice(cancelAt, 1))
  return rows
}

/** True when the elicitation's form has fields (the card then can't answer it from rows). */
function elicitationFields(params: Record<string, unknown>): string[] {
  const schema = isRecord(params.requestedSchema) ? params.requestedSchema : {}
  return isRecord(schema.properties) ? Object.keys(schema.properties) : []
}

/** The card for a Codex request (see the module header). */
export function buildCodexApprovalView(
  req: PermissionRequestEvent,
  ctx: PermissionViewCtx
): PermissionView {
  const params = isRecord(req.input) ? req.input : {}
  const agent = ctx.agent ?? 'Codex'
  const reason = str(params.reason)
  const base = {
    canAmend: false,
    defaultIndex: 0,
    footer: 'Esc to cancel',
    ...(reason ? { decisionReason: reason } : {})
  }
  if (COMMAND_METHODS.has(req.toolName)) {
    const cwd = str(params.cwd)
    return {
      ...base,
      title: 'Run command',
      ...(cwd && cwd !== ctx.cwd ? { subtitle: `in ${cwd}` } : {}),
      question: 'Do you want to run this command?',
      options: decisionRows(params, false, agent)
    }
  }
  if (FILE_METHODS.has(req.toolName)) {
    const grantRoot = str(params.grantRoot)
    return {
      ...base,
      title: 'Edit files',
      ...(grantRoot ? { subtitle: `and allow writes under ${grantRoot}` } : {}),
      question: 'Do you want to make these changes?',
      options: decisionRows(params, true, agent)
    }
  }
  if (req.toolName === CODEX_PERMISSIONS_APPROVAL) {
    return {
      ...base,
      footer: 'Esc to decline',
      title: 'Permissions',
      question: `Do you want to give ${agent} these permissions?`,
      options: [
        { id: 'yes', label: 'Yes, for this turn', decision: allow() },
        {
          id: 'yes-session',
          label: 'Yes, for this session',
          decision: allow({ scope: 'session' })
        },
        { id: 'no', label: 'No', decision: DECLINE }
      ]
    }
  }
  // MCP elicitation: a server asks the user (to confirm, or to fill a form).
  const server = str(params.serverName) ?? 'An MCP server'
  const fields = elicitationFields(params)
  return {
    ...base,
    title: `${server} asks`,
    question: str(params.message) ?? `${server} needs your input.`,
    ...(fields.length > 0
      ? {
          tip: `It asks for ${fields.join(', ')}: chat can't fill in this form, decline or cancel.`
        }
      : {}),
    options: [
      ...(fields.length === 0
        ? [{ id: 'accept', label: 'Accept', decision: allow({ updatedInput: { content: {} } }) }]
        : []),
      { id: 'no', label: 'Decline', decision: DECLINE },
      { id: 'cancel', label: 'Cancel (esc)', decision: CANCEL }
    ]
  }
}
