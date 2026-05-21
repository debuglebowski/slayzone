import fs from 'fs/promises'
import path from 'path'
import { getClaudeSettingsPath, writeFileIfChanged } from '@slayzone/platform'
import { formatHookCommand } from './hook-paths'

const MARKER_KEY = '_slayzoneManaged'

/**
 * Claude Code hook event names we install on. Matches the 9 events documented
 * in Claude Code 2.x. Each maps to one entry in `settings.hooks[event]`.
 */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'Notification',
  'PreCompact'
] as const

const TOOL_MATCHED_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse', 'Notification'])

interface ClaudeHookCommand {
  type: 'command'
  command: string
  [MARKER_KEY]?: boolean
}

interface ClaudeHookEntry {
  matcher?: string
  hooks: ClaudeHookCommand[]
}

type ClaudeSettings = {
  hooks?: Record<string, ClaudeHookEntry[]>
  [key: string]: unknown
}

export interface InstallClaudeHooksOpts {
  /** Absolute path to the notify script. Forwarded into the hook command. */
  scriptPath: string
  /** Override target settings.json path. Defaults to `getClaudeSettingsPath()`. */
  settingsPath?: string
  /** Override list of hook events. Defaults to `CLAUDE_HOOK_EVENTS`. */
  events?: readonly string[]
}

export interface InstallClaudeHooksResult {
  installed: boolean
  eventsAdded: string[]
  reason?: string
}

/**
 * Merge SlayZone hook entries into `~/.claude/settings.json` (atomic, idempotent).
 *
 * Behavior:
 * - Missing file → starts from `{}`, mkdir parent.
 * - Malformed JSON → aborts (does NOT overwrite user data). Returns `installed: false`.
 * - For each event in `events`: replaces any existing SlayZone-managed entry,
 *   preserves all other user-defined entries.
 * - SlayZone-managed entries are identified by either:
 *     a) inner hook command containing `notify.sh`, OR
 *     b) inner hook carries `_slayzoneManaged: true` marker.
 *   This handles users who hand-edit or relocate the script.
 * - Atomic write via `writeFileIfChanged` (no-op if content unchanged).
 */
export async function installClaudeHooks(
  opts: InstallClaudeHooksOpts
): Promise<InstallClaudeHooksResult> {
  const target = opts.settingsPath ?? getClaudeSettingsPath()
  const events = opts.events ?? CLAUDE_HOOK_EVENTS

  let settings: ClaudeSettings
  try {
    const raw = await fs.readFile(target, 'utf8')
    try {
      const parsed = JSON.parse(raw)
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { installed: false, eventsAdded: [], reason: 'settings.json is not a JSON object' }
      }
      settings = parsed as ClaudeSettings
    } catch {
      return {
        installed: false,
        eventsAdded: [],
        reason: 'settings.json is not valid JSON — refusing to overwrite'
      }
    }
  } catch (err: unknown) {
    if (!isENOENT(err)) throw err
    settings = {}
  }

  const hooks = (settings.hooks ??= {})
  const added: string[] = []

  for (const event of events) {
    const list = (hooks[event] ??= [])
    const filtered = list
      .map(stripManagedFromEntry)
      .filter((entry): entry is ClaudeHookEntry => entry !== null && entry.hooks.length > 0)
    const managedEntry = buildManagedEntry(event, opts.scriptPath)
    filtered.push(managedEntry)
    hooks[event] = filtered
    added.push(event)
  }

  await fs.mkdir(path.dirname(target), { recursive: true })
  await writeFileIfChanged(target, JSON.stringify(settings, null, 2) + '\n')

  return { installed: true, eventsAdded: added }
}

function buildManagedEntry(event: string, scriptPath: string): ClaudeHookEntry {
  const entry: ClaudeHookEntry = {
    hooks: [
      {
        type: 'command',
        command: formatHookCommand(scriptPath),
        [MARKER_KEY]: true
      }
    ]
  }
  if (TOOL_MATCHED_EVENTS.has(event)) entry.matcher = '*'
  return entry
}

/**
 * Returns the entry with any SlayZone-managed inner hooks removed.
 * Returns null if the entry's `hooks` array is missing or malformed.
 */
function stripManagedFromEntry(entry: unknown): ClaudeHookEntry | null {
  if (entry == null || typeof entry !== 'object') return null
  const e = entry as Partial<ClaudeHookEntry>
  if (!Array.isArray(e.hooks)) return null
  const innerHooks = e.hooks.filter((h) => !isManagedSlayzoneHook(h))
  return { ...e, hooks: innerHooks } as ClaudeHookEntry
}

/**
 * Predicate: does this inner-hook entry belong to SlayZone? Matches by marker
 * first (canonical), falls back to script path substring (handles legacy /
 * hand-edited installs).
 */
export function isManagedSlayzoneHook(hook: unknown): boolean {
  if (hook == null || typeof hook !== 'object') return false
  const h = hook as ClaudeHookCommand
  if (h[MARKER_KEY] === true) return true
  const cmd = typeof h.command === 'string' ? h.command : ''
  return cmd.includes('.slayzone/hooks/notify.sh') || cmd.includes('/slayzone/hooks/notify.sh')
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err != null && (err as { code?: string }).code === 'ENOENT'
}
