/**
 * Pure helpers that extract Claude Code background-shell signals from
 * generic ToolCallEvent / ToolResultEvent payloads.
 *
 * Claude Code's `Bash` tool spawns a background shell when invoked with
 * `run_in_background: true`. The original `tool_use` carries the command;
 * the matching `tool_result` carries the assigned `shell_id` (e.g. `bash_1`).
 * Subsequent `BashOutput` calls poll the shell — their `tool_result` exposes
 * status / exit code. `KillShell` terminates a shell explicitly.
 *
 * This module isolates parsing details so chat-timeline reducer + UI can
 * stay parser-agnostic. Both structured (`tool_use_result`) and free-text
 * (`content`) shapes are inspected to survive minor schema drift across
 * Claude Code releases.
 */
import type { ToolCallEvent, ToolResultEvent } from './agent-events'

export interface BgShellSpawnSignal {
  toolUseId: string
  command: string
  description?: string
  timeout?: number
}

export interface BashOutputSignal {
  toolUseId: string
  shellId: string
  filter?: string
}

export interface KillShellSignal {
  toolUseId: string
  shellId: string
}

export interface BashOutputStatusSignal {
  shellId: string | null
  status: 'running' | 'completed' | 'failed' | 'killed' | null
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * Detect a Bash tool call that spawned a background shell.
 * Returns null if not a bg spawn.
 */
export function extractBgShellSpawn(event: ToolCallEvent): BgShellSpawnSignal | null {
  if (event.name !== 'Bash') return null
  const input = asObject(event.input)
  if (!input) return null
  if (input.run_in_background !== true) return null
  const command = typeof input.command === 'string' ? input.command : ''
  return {
    toolUseId: event.id,
    command,
    description: typeof input.description === 'string' ? input.description : undefined,
    timeout: typeof input.timeout === 'number' ? input.timeout : undefined
  }
}

/**
 * Pull a shell id from a Bash bg spawn's tool_result. Tries `structured.shellId`
 * (preferred) then falls back to scraping the rawContent text for `bash_<n>` /
 * `shell ID: <id>`.
 */
export function extractShellIdFromSpawnResult(result: ToolResultEvent): string | null {
  const structured = asObject(result.structured)
  if (structured) {
    const id = structured.shellId ?? structured.shell_id ?? structured.bash_id ?? structured.bashId
    if (typeof id === 'string' && id.length > 0) return id
  }
  const text = rawContentText(result.rawContent)
  if (!text) return null
  const m = /shell\s*id\s*[:=]\s*([A-Za-z0-9_-]+)/i.exec(text) ?? /\b(bash_\d+)\b/.exec(text)
  return m ? m[1] : null
}

/**
 * Detect a `BashOutput` poll. Returns the shell id targeted by the call.
 */
export function extractBashOutputCall(event: ToolCallEvent): BashOutputSignal | null {
  if (event.name !== 'BashOutput') return null
  const input = asObject(event.input)
  if (!input) return null
  const id = input.bash_id ?? input.bashId ?? input.shell_id ?? input.shellId
  if (typeof id !== 'string' || !id) return null
  return {
    toolUseId: event.id,
    shellId: id,
    filter: typeof input.filter === 'string' ? input.filter : undefined
  }
}

/**
 * Detect a `KillShell` call.
 */
export function extractKillShellCall(event: ToolCallEvent): KillShellSignal | null {
  if (event.name !== 'KillShell') return null
  const input = asObject(event.input)
  if (!input) return null
  const id = input.shell_id ?? input.shellId ?? input.bash_id ?? input.bashId
  if (typeof id !== 'string' || !id) return null
  return { toolUseId: event.id, shellId: id }
}

/**
 * Parse a `BashOutput` tool_result for status + output. Status comes from the
 * structured payload when available, otherwise from text scraping. Returns
 * stdout/stderr as strings (empty if unavailable). `shellId` is best-effort —
 * the result itself often omits it; caller correlates via the original call.
 */
export function extractBashOutputResult(result: ToolResultEvent): BashOutputStatusSignal {
  const structured = asObject(result.structured)
  let status: BashOutputStatusSignal['status'] = null
  let exitCode: number | null = null
  let stdout = ''
  let stderr = ''
  let shellId: string | null = null

  if (structured) {
    const rawStatus = structured.status
    if (typeof rawStatus === 'string') status = normalizeStatus(rawStatus)
    const rawExit = structured.exitCode ?? structured.exit_code
    if (typeof rawExit === 'number') exitCode = rawExit
    if (typeof structured.stdout === 'string') stdout = structured.stdout
    if (typeof structured.stderr === 'string') stderr = structured.stderr
    const id = structured.shellId ?? structured.shell_id ?? structured.bashId ?? structured.bash_id
    if (typeof id === 'string') shellId = id
  }

  if (status === null || stdout === '' || stderr === '') {
    const text = rawContentText(result.rawContent) ?? ''
    if (status === null) {
      const m = /^\s*status\s*:\s*(\w+)/im.exec(text)
      if (m) status = normalizeStatus(m[1])
    }
    if (exitCode === null) {
      const m = /^\s*exit\s*code\s*:\s*(-?\d+)/im.exec(text)
      if (m) exitCode = Number.parseInt(m[1], 10)
    }
  }

  // Failed implies non-zero exit; treat is_error w/o explicit status as failed.
  if (status === null && result.isError) status = 'failed'

  return { shellId, status, exitCode, stdout, stderr }
}

function normalizeStatus(s: string): BashOutputStatusSignal['status'] {
  const v = s.toLowerCase()
  if (v === 'running' || v === 'in_progress' || v === 'pending') return 'running'
  if (v === 'completed' || v === 'success' || v === 'done' || v === 'exited') return 'completed'
  if (v === 'killed' || v === 'terminated') return 'killed'
  if (v === 'failed' || v === 'error') return 'failed'
  return null
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function rawContentText(raw: unknown): string | null {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    const parts: string[] = []
    for (const block of raw) {
      const obj = asObject(block)
      if (obj && typeof obj.text === 'string') parts.push(obj.text)
    }
    return parts.length > 0 ? parts.join('\n') : null
  }
  return null
}
