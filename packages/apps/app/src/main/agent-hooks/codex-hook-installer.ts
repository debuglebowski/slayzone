import fs from 'fs/promises'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { getCodexHooksPath, getSlayzoneHomeDir, writeFileIfChanged } from '@slayzone/platform'
import { formatHookCommand } from './hook-paths'

const execP = promisify(exec)

const MARKER_KEY = '_slayzoneManaged'

/**
 * Codex CLI hook events (hooks system, stable + default-enabled from 0.129).
 * Each maps to one entry in `hooks.json`'s `hooks[event]` array. These are the
 * standard event names — the server's `mapEventType()` already aliases them.
 */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'PermissionRequest'
] as const

// Codex matches tool-scoped events against `tool_name`; `.*` = every tool.
// Lifecycle events take no matcher (fire unconditionally).
const TOOL_MATCHED_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse'])

// Codex `hooks` subsystem is stable + default-enabled from 0.129. Below that,
// hooks.json may be ignored.
const MIN_CODEX_VERSION = { major: 0, minor: 129 }

interface CodexHookCommand {
  type: 'command'
  command: string
  [MARKER_KEY]?: boolean
}

interface CodexHookEntry {
  matcher?: string
  hooks: CodexHookCommand[]
}

type CodexHooksFile = {
  hooks?: Record<string, CodexHookEntry[]>
  [key: string]: unknown
}

export interface InstallCodexHooksOpts {
  /** Absolute path to the notify script. Forwarded into the hook command. */
  scriptPath: string
  /** Override target hooks.json path. Defaults to `getCodexHooksPath()`. */
  hooksPath?: string
  /** Override list of hook events. Defaults to `CODEX_HOOK_EVENTS`. */
  events?: readonly string[]
  /**
   * Skip the `codex --version` probe. Tests pass `true` so the installer runs
   * against a tmp dir without needing the binary on PATH.
   */
  skipVersionProbe?: boolean
}

export interface InstallCodexHooksResult {
  installed: boolean
  eventsAdded: string[]
  reason?: string
}

/**
 * Merge SlayZone hook entries into `~/.codex/hooks.json` (atomic, idempotent).
 *
 * Replaces the legacy `~/.slayzone/bin/codex` bash wrapper: Codex's first-class
 * hooks system covers every lifecycle event the wrapper synthesized, and a
 * declarative config file works on Windows where an extensionless bash shim
 * cannot.
 *
 * Behavior (mirrors `installClaudeHooks`):
 * - `codex` binary missing → skip install (no file written). Opt-in like Gemini.
 * - Missing file → starts from `{}`, mkdir parent.
 * - Malformed JSON → aborts (does NOT overwrite user data).
 * - For each event: replaces any existing SlayZone-managed entry, preserves
 *   user-defined entries. Managed entries carry `_slayzoneManaged: true`.
 * - Atomic write via `writeFileIfChanged` (no-op if unchanged).
 */
export async function installCodexHooks(
  opts: InstallCodexHooksOpts
): Promise<InstallCodexHooksResult> {
  // E2E specs assert the file is written; the runner has no `codex` on PATH.
  const skipProbe = opts.skipVersionProbe || process.env.SLAYZONE_E2E_INSTALL_HOOKS === '1'
  if (!skipProbe) {
    const probed = await probeCodexVersion()
    if (!probed) {
      return { installed: false, eventsAdded: [], reason: 'codex binary not on PATH' }
    }
    if (!isAtLeast(probed, MIN_CODEX_VERSION)) {
      console.warn(
        `[agent-hooks] codex ${probed.raw} detected; hooks system is stable in ` +
          `≥${MIN_CODEX_VERSION.major}.${MIN_CODEX_VERSION.minor}. Lifecycle events may not fire.`
      )
    }
  }

  const target = opts.hooksPath ?? getCodexHooksPath()
  const events = opts.events ?? CODEX_HOOK_EVENTS

  let config: CodexHooksFile
  try {
    const raw = await fs.readFile(target, 'utf8')
    try {
      const parsed = JSON.parse(raw)
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { installed: false, eventsAdded: [], reason: 'hooks.json is not a JSON object' }
      }
      config = parsed as CodexHooksFile
    } catch {
      return {
        installed: false,
        eventsAdded: [],
        reason: 'hooks.json is not valid JSON — refusing to overwrite'
      }
    }
  } catch (err: unknown) {
    if (!isENOENT(err)) throw err
    config = {}
  }

  const hooks = (config.hooks ??= {})
  const added: string[] = []

  for (const event of events) {
    const list = (hooks[event] ??= [])
    const filtered = list
      .map(stripManagedFromEntry)
      .filter((entry): entry is CodexHookEntry => entry !== null && entry.hooks.length > 0)
    filtered.push(buildManagedEntry(event, opts.scriptPath))
    hooks[event] = filtered
    added.push(event)
  }

  await fs.mkdir(path.dirname(target), { recursive: true })
  await writeFileIfChanged(target, JSON.stringify(config, null, 2) + '\n')

  return { installed: true, eventsAdded: added }
}

function buildManagedEntry(event: string, scriptPath: string): CodexHookEntry {
  const entry: CodexHookEntry = {
    hooks: [
      {
        type: 'command',
        // Explicit `bash` invocation: notify.sh is a bash script and needs
        // bash (Git Bash on Windows) regardless. Making it explicit removes any
        // dependency on which shell Codex uses to run the command string.
        command: `bash ${formatHookCommand(scriptPath)}`,
        [MARKER_KEY]: true
      }
    ]
  }
  if (TOOL_MATCHED_EVENTS.has(event)) entry.matcher = '.*'
  return entry
}

/**
 * Returns the entry with any SlayZone-managed inner hooks removed.
 * Returns null if the entry's `hooks` array is missing or malformed.
 */
function stripManagedFromEntry(entry: unknown): CodexHookEntry | null {
  if (entry == null || typeof entry !== 'object') return null
  const e = entry as Partial<CodexHookEntry>
  if (!Array.isArray(e.hooks)) return null
  const innerHooks = e.hooks.filter((h) => !isManagedSlayzoneHook(h))
  return { ...e, hooks: innerHooks } as CodexHookEntry
}

/**
 * Predicate: does this inner-hook entry belong to SlayZone? Matches by marker
 * first (canonical), falls back to script path substring (hand-edited installs).
 */
export function isManagedSlayzoneHook(hook: unknown): boolean {
  if (hook == null || typeof hook !== 'object') return false
  const h = hook as CodexHookCommand
  if (h[MARKER_KEY] === true) return true
  const cmd = typeof h.command === 'string' ? h.command : ''
  return cmd.includes('.slayzone/hooks/notify.sh') || cmd.includes('/slayzone/hooks/notify.sh')
}

/**
 * Remove the legacy `~/.slayzone/bin/codex` bash wrapper from prior installs.
 * Identified by the wrapper's header marker so we never delete a user file.
 * Idempotent — returns false when nothing was removed.
 */
export async function uninstallCodexWrapper(opts: { wrapperPath?: string } = {}): Promise<boolean> {
  const target = opts.wrapperPath ?? path.join(getSlayzoneHomeDir(), 'bin', 'codex')
  try {
    const content = await fs.readFile(target, 'utf8')
    if (!content.includes('slayzone codex wrapper')) return false
    await fs.unlink(target)
    return true
  } catch (err: unknown) {
    if (isENOENT(err)) return false
    throw err
  }
}

interface ParsedVersion {
  major: number
  minor: number
  raw: string
}

async function probeCodexVersion(): Promise<ParsedVersion | null> {
  try {
    // Strip ~/.slayzone/bin so a stale wrapper (pre-uninstall) doesn't answer.
    const { stdout } = await execP('codex --version', {
      timeout: 3000,
      env: { ...process.env, PATH: stripSlayzoneBin(process.env.PATH ?? '') }
    })
    return parseCodexVersion(stdout.trim())
  } catch {
    return null
  }
}

function stripSlayzoneBin(pathVar: string): string {
  const sep = process.platform === 'win32' ? ';' : ':'
  const ours = path.join(getSlayzoneHomeDir(), 'bin')
  return pathVar
    .split(sep)
    .filter((p) => p !== ours)
    .join(sep)
}

/** Parses "codex 0.131.0" / "0.129.0-alpha" / "codex-cli 1.2.3". Null on unparseable. */
export function parseCodexVersion(raw: string): ParsedVersion | null {
  const match = raw.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), raw }
}

function isAtLeast(v: ParsedVersion, min: { major: number; minor: number }): boolean {
  if (v.major !== min.major) return v.major > min.major
  return v.minor >= min.minor
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err != null && (err as { code?: string }).code === 'ENOENT'
}
