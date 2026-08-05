import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getAntigravityHooksPath } from '../dirs'
import { updateFileAtomically } from '../fs-utils'
import { formatHookCommand } from './hook-paths'

const execFileAsync = promisify(execFile)

/**
 * Top-level named-hook key SlayZone owns in the Antigravity hooks.json.
 * Antigravity's schema is `{ "<hook-name>": { "<Event>": [...] } }` — SlayZone
 * claims this one name, so install = overwrite this key, leave all others intact.
 */
const SLAYZONE_HOOK_NAME = 'slayzone-notify'

/**
 * Antigravity (`agy`) hook events SlayZone registers. `agy` does NOT put the
 * event name in the payload, so each handler command is suffixed with the
 * event name as an argv arg (notify.sh reads `$1`).
 *
 * Chosen so notify.sh's fixed `{}` stdout is a SAFE response for every one:
 *   PreInvocation `{}` → no injected steps
 *   PostToolUse   `{}` → expected empty output
 *   Stop          `{}` → no `decision` → stop allowed (not "continue")
 * `PreToolUse` is intentionally omitted — its `{}` output (no `decision`) risks
 * gating every tool call.
 */
export const ANTIGRAVITY_HOOK_EVENTS = ['PreInvocation', 'PostToolUse', 'Stop'] as const

/** Events whose handler entries take a tool-name `matcher` (regex). */
const TOOL_MATCHED_EVENTS = new Set<string>(['PostToolUse'])

interface AntigravityHookHandler {
  type: 'command'
  command: string
}

interface AntigravityHookEntry {
  matcher?: string
  hooks: AntigravityHookHandler[]
}

/** One named hook: optional `enabled` flag + per-event handler arrays. */
type AntigravityNamedHook = {
  enabled?: boolean
  [event: string]: unknown
}

type AntigravityHooksFile = Record<string, AntigravityNamedHook>

export interface InstallAntigravityHooksOpts {
  /** Absolute path to the notify script. Forwarded into the hook command. */
  scriptPath: string
  /** Override target hooks.json path. Defaults to `getAntigravityHooksPath()`. */
  hooksPath?: string
  /** Override list of hook events. Defaults to `ANTIGRAVITY_HOOK_EVENTS`. */
  events?: readonly string[]
  /**
   * Skip the `agy --version` probe. Tests pass `true` so the installer runs
   * against a tmp dir without needing the binary on PATH.
   */
  skipBinaryProbe?: boolean
}

export interface InstallAntigravityHooksResult {
  installed: boolean
  eventsAdded: string[]
  reason?: string
}

/**
 * Probe for the `agy` binary (the Antigravity CLI). We skip install when absent
 * — like Gemini, Antigravity is opt-in, so writing into `~/.gemini/config/` for
 * users who don't have it would pollute their home dir.
 */
async function isAntigravityInstalled(): Promise<boolean> {
  try {
    await execFileAsync('agy', ['--version'], { timeout: 2000 })
    return true
  } catch {
    return false
  }
}

/**
 * Write SlayZone's notify hook into the Antigravity (`agy`) hooks.json
 * (`~/.gemini/config/hooks.json`) — atomic, idempotent.
 *
 * Behavior:
 * - `agy` binary missing → skip install (no file written, no mkdir).
 * - Missing file → starts from `{}`, mkdir parent.
 * - Malformed JSON → aborts (does NOT overwrite user data).
 * - Overwrites the whole `slayzone-notify` named-hook key; every OTHER named
 *   hook in the file is preserved untouched. Antigravity's named-hook schema
 *   makes a dedicated key SlayZone's namespace — no per-entry markers needed.
 * - Read+merge+write is one guarded cycle via `updateFileAtomically`.
 */
export async function installAntigravityHooks(
  opts: InstallAntigravityHooksOpts
): Promise<InstallAntigravityHooksResult> {
  // E2E specs assert the file is written; the test runner doesn't have `agy`
  // on PATH, so the probe would otherwise short-circuit.
  const skipProbe = opts.skipBinaryProbe || process.env.SLAYZONE_E2E_INSTALL_HOOKS === '1'
  if (!skipProbe) {
    const present = await isAntigravityInstalled()
    if (!present) {
      return { installed: false, eventsAdded: [], reason: 'agy binary not on PATH' }
    }
  }

  const target = opts.hooksPath ?? getAntigravityHooksPath()
  const events = opts.events ?? ANTIGRAVITY_HOOK_EVENTS

  // Read + merge + write as ONE guarded cycle — see installClaudeHooks for why a
  // separate read and write silently drops a concurrent peer's entries.
  let result: InstallAntigravityHooksResult = {
    installed: false,
    eventsAdded: [],
    reason: 'unwritten'
  }

  await updateFileAtomically(target, (current) => {
    let hooksFile: AntigravityHooksFile
    if (current === null) {
      hooksFile = {}
    } else {
      let parsed: unknown
      try {
        parsed = JSON.parse(current.toString('utf8'))
      } catch {
        result = {
          installed: false,
          eventsAdded: [],
          reason: 'hooks.json is not valid JSON — refusing to overwrite'
        }
        return null
      }
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        result = { installed: false, eventsAdded: [], reason: 'hooks.json is not a JSON object' }
        return null
      }
      hooksFile = parsed as AntigravityHooksFile
    }

    // SlayZone owns the `slayzone-notify` key entirely — rebuild it from scratch.
    // Other named hooks in the file are left exactly as they were.
    const named: AntigravityNamedHook = {}
    const added: string[] = []
    for (const event of events) {
      named[event] = [buildEntry(event, opts.scriptPath)]
      added.push(event)
    }
    hooksFile[SLAYZONE_HOOK_NAME] = named

    result = { installed: true, eventsAdded: added }
    return JSON.stringify(hooksFile, null, 2) + '\n'
  })

  return result
}

function buildEntry(event: string, scriptPath: string): AntigravityHookEntry {
  // Antigravity omits the event name from the hook payload — pass it as an argv
  // arg so notify.sh ($1) can resolve it. Event names are plain identifiers
  // (no shell metacharacters), so appending unquoted is safe.
  const entry: AntigravityHookEntry = {
    hooks: [{ type: 'command', command: `${formatHookCommand(scriptPath)} ${event}` }]
  }
  if (TOOL_MATCHED_EVENTS.has(event)) entry.matcher = '*'
  return entry
}
