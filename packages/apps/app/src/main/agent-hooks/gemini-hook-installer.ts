import fs from 'fs/promises'
import path from 'path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getGeminiSettingsPath, writeFileIfChanged } from '@slayzone/platform'
import { formatHookCommand } from './hook-paths'

const execFileAsync = promisify(execFile)

const MARKER_KEY = '_slayzoneManaged'

/**
 * Gemini CLI hook event names (v0.13.0+). Each maps to one entry in
 * `settings.hooks[event]`. We register only the lifecycle events SlayZone
 * surfaces today; BeforeTool is intentionally omitted (would map to
 * permission-request but adds noise without a UI surface yet).
 */
export const GEMINI_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'AfterTool'
] as const

const TOOL_MATCHED_EVENTS = new Set<string>(['AfterTool'])

interface GeminiHookCommand {
  type: 'command'
  command: string
  [MARKER_KEY]?: boolean
}

interface GeminiHookEntry {
  matcher?: string
  sequential?: boolean
  hooks: GeminiHookCommand[]
}

type GeminiSettings = {
  hooks?: Record<string, GeminiHookEntry[]>
  [key: string]: unknown
}

export interface InstallGeminiHooksOpts {
  /** Absolute path to the notify script. Forwarded into the hook command. */
  scriptPath: string
  /** Override target settings.json path. Defaults to `getGeminiSettingsPath()`. */
  settingsPath?: string
  /** Override list of hook events. Defaults to `GEMINI_HOOK_EVENTS`. */
  events?: readonly string[]
  /**
   * Skip the `gemini --version` probe. Tests pass `true` so the installer
   * runs against a tmp dir without needing the binary on PATH.
   */
  skipBinaryProbe?: boolean
}

export interface InstallGeminiHooksResult {
  installed: boolean
  eventsAdded: string[]
  reason?: string
}

/**
 * Probe for the `gemini` binary. We skip install entirely when absent —
 * unlike Claude (default for many SlayZone users), Gemini is opt-in, so
 * writing `~/.gemini/settings.json` for users who don't have it would
 * pollute their home dir.
 */
async function isGeminiInstalled(): Promise<boolean> {
  try {
    await execFileAsync('gemini', ['--version'], { timeout: 2000 })
    return true
  } catch {
    return false
  }
}

/**
 * Merge SlayZone hook entries into `~/.gemini/settings.json` (atomic, idempotent).
 *
 * Behavior:
 * - `gemini` binary missing → skip install (no file written, no parent mkdir).
 * - Missing file → starts from `{}`, mkdir parent.
 * - Malformed JSON → aborts (does NOT overwrite user data).
 * - For each event: replaces any existing SlayZone-managed entry,
 *   preserves user-defined entries.
 * - SlayZone-managed entries identified by `_slayzoneManaged: true` marker
 *   or substring match on `notify.sh`.
 * - `AfterTool` gets `matcher: '*'`; lifecycle events have no matcher.
 * - Atomic write via `writeFileIfChanged` (no-op if unchanged).
 */
export async function installGeminiHooks(
  opts: InstallGeminiHooksOpts
): Promise<InstallGeminiHooksResult> {
  // E2E specs assert the file is written; the test runner doesn't have
  // `gemini` on PATH, so the probe would otherwise short-circuit. Same env
  // flag that opts the boot installer back in under PLAYWRIGHT.
  const skipProbe = opts.skipBinaryProbe || process.env.SLAYZONE_E2E_INSTALL_HOOKS === '1'
  if (!skipProbe) {
    const present = await isGeminiInstalled()
    if (!present) {
      return { installed: false, eventsAdded: [], reason: 'gemini binary not on PATH' }
    }
  }

  const target = opts.settingsPath ?? getGeminiSettingsPath()
  const events = opts.events ?? GEMINI_HOOK_EVENTS

  let settings: GeminiSettings
  try {
    const raw = await fs.readFile(target, 'utf8')
    try {
      const parsed = JSON.parse(raw)
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { installed: false, eventsAdded: [], reason: 'settings.json is not a JSON object' }
      }
      settings = parsed as GeminiSettings
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
      .filter((entry): entry is GeminiHookEntry => entry !== null && entry.hooks.length > 0)
    const managedEntry = buildManagedEntry(event, opts.scriptPath)
    filtered.push(managedEntry)
    hooks[event] = filtered
    added.push(event)
  }

  await fs.mkdir(path.dirname(target), { recursive: true })
  await writeFileIfChanged(target, JSON.stringify(settings, null, 2) + '\n')

  return { installed: true, eventsAdded: added }
}

function buildManagedEntry(event: string, scriptPath: string): GeminiHookEntry {
  const entry: GeminiHookEntry = {
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

function stripManagedFromEntry(entry: unknown): GeminiHookEntry | null {
  if (entry == null || typeof entry !== 'object') return null
  const e = entry as Partial<GeminiHookEntry>
  if (!Array.isArray(e.hooks)) return null
  const innerHooks = e.hooks.filter((h) => !isManagedSlayzoneHook(h))
  return { ...e, hooks: innerHooks } as GeminiHookEntry
}

export function isManagedSlayzoneHook(hook: unknown): boolean {
  if (hook == null || typeof hook !== 'object') return false
  const h = hook as GeminiHookCommand
  if (h[MARKER_KEY] === true) return true
  const cmd = typeof h.command === 'string' ? h.command : ''
  return cmd.includes('.slayzone/hooks/notify.sh') || cmd.includes('/slayzone/hooks/notify.sh')
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err != null && (err as { code?: string }).code === 'ENOENT'
}
