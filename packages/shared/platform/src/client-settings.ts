import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getClientRoot } from './dirs'
import { readJsonObject, writeJsonAtomic } from './slayzone-config'

/**
 * The desktop client's own settings — the values Electron main needs BEFORE any
 * hub exists.
 *
 * This is the generalization of the rule already stated at the top of
 * `boot-config.ts`: if a process that cannot assume a hub exists needs a value,
 * that value must not live on a hub. `theme` is applied before the first window is
 * created (to avoid a flash), the native menu is built from `custom_shortcuts` and
 * the `labs_*` flags, and the floating panel's geometry is a property of this
 * display. None of them can wait for a round trip to a server that may not be
 * running, or may be in another country.
 *
 * It also fixes a live split-brain: `initDatabases()` was never gated on mode, so
 * in REMOTE mode main read these keys from a local database while the renderer
 * wrote them to the remote hub. The theme toggle already didn't stick.
 *
 * NOT a store for UI preferences generally. Appearance, panel layout and anything
 * project-keyed stay hub-side — project ids are only unique within one hub's
 * database, and "my editor is configured the same on every machine" is a feature.
 */

export type ClientSettings = {
  /** AUTHORITATIVE — read before the first window exists. */
  theme?: 'light' | 'dark' | 'system'
  /** AUTHORITATIVE — native menu accelerators, built pre-hub. Per-machine. */
  customShortcuts?: Record<string, string | null>
  /** AUTHORITATIVE — gate native menu items. */
  labs?: { testsPanel?: boolean; loopMode?: boolean }
  /** AUTHORITATIVE — geometry of a native window on this display. */
  floatingAgentPanel?: {
    config?: unknown
    expandedSize?: { width: number; height: number }
  }
  /** AUTHORITATIVE — governs the machine-local diagnostics database. */
  diagnostics?: {
    enabled?: boolean
    verbose?: boolean
    includePtyOutput?: boolean
    retentionDays?: number
  }
  /** AUTHORITATIVE — "have I warned about the stale symlink on THIS box". */
  cli?: { migrationDialogShown?: boolean }
}

const FILE_NAME = 'client-settings.json'

export function clientSettingsPath(dir: string = getClientRoot()): string {
  return join(dir, FILE_NAME)
}

/**
 * DB key → JSON path. This map IS the scope ruling expressed as code, which is why
 * it lives next to the type rather than in the migration: the migration should not
 * be the only place that records which keys are client-scoped.
 */
export const CLIENT_SETTINGS_KEYS = [
  'theme',
  'custom_shortcuts',
  'labs_tests_panel',
  'labs_loop_mode',
  'floatingGlobalAgentPanelConfig',
  'floatingGlobalAgentPanelExpandedSize',
  'diagnostics_enabled',
  'diagnostics_verbose',
  'diagnostics_include_pty_output',
  'diagnostics_retention_days',
  'cli_migration_dialog_shown'
] as const

const asBool = (v: unknown): boolean | undefined =>
  typeof v === 'boolean' ? v : v === '1' ? true : v === '0' ? false : undefined

const asPosInt = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * Coerce field-by-field so a hand-edited or half-written file reads as UNSET
 * rather than half-applied. Every group is independent: one malformed section
 * must not discard the others.
 */
function coerce(raw: Record<string, unknown>): ClientSettings {
  const out: ClientSettings = {}
  if (raw.theme === 'light' || raw.theme === 'dark' || raw.theme === 'system') out.theme = raw.theme
  if (raw.customShortcuts && typeof raw.customShortcuts === 'object') {
    const src = raw.customShortcuts as Record<string, unknown>
    const map: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'string' || v === null) map[k] = v
    }
    out.customShortcuts = map
  }
  if (raw.labs && typeof raw.labs === 'object') {
    const l = raw.labs as Record<string, unknown>
    out.labs = { testsPanel: asBool(l.testsPanel), loopMode: asBool(l.loopMode) }
  }
  if (raw.floatingAgentPanel && typeof raw.floatingAgentPanel === 'object') {
    const f = raw.floatingAgentPanel as Record<string, unknown>
    const panel: NonNullable<ClientSettings['floatingAgentPanel']> = {}
    if (f.config !== undefined) panel.config = f.config
    const size = f.expandedSize as { width?: unknown; height?: unknown } | undefined
    if (size && typeof size.width === 'number' && typeof size.height === 'number') {
      panel.expandedSize = { width: size.width, height: size.height }
    }
    out.floatingAgentPanel = panel
  }
  if (raw.diagnostics && typeof raw.diagnostics === 'object') {
    const d = raw.diagnostics as Record<string, unknown>
    out.diagnostics = {
      enabled: asBool(d.enabled),
      verbose: asBool(d.verbose),
      includePtyOutput: asBool(d.includePtyOutput),
      retentionDays: asPosInt(d.retentionDays)
    }
  }
  if (raw.cli && typeof raw.cli === 'object') {
    out.cli = { migrationDialogShown: asBool((raw.cli as Record<string, unknown>).migrationDialogShown) }
  }
  return out
}

/**
 * Never throws. A missing file is all-defaults.
 *
 * A file that exists but does not PARSE is different, and is not treated as
 * "defaults": that would silently flip a light-mode user to dark and read as a
 * preference change rather than a fault. It is renamed aside so the failure is
 * visible and the bytes are recoverable.
 */
export function readClientSettings(dir: string = getClientRoot()): ClientSettings {
  const path = clientSettingsPath(dir)
  const raw = readJsonObject(path)
  if (raw === null) {
    try {
      // Distinguish "absent" from "unparseable": readJsonObject returns null for
      // both, but only one of them has bytes worth keeping.
      if (existsSync(path)) {
        renameSync(path, `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`)
      }
    } catch {
      /* best-effort — never block boot on this */
    }
    return {}
  }
  return coerce(raw)
}

/**
 * Merge over the RAW parsed object, not the coerced one.
 *
 * Deliberately different from `updateHubConfigFile`, which coerces first and so
 * drops unknown fields. Here a v1 binary writing a file authored by v2 must
 * preserve v2's fields rather than delete them — that, plus reading unknown
 * versions field-by-field, is the whole downgrade story and is why there is no
 * version gate.
 *
 * Writes are serialized through one chain: `writeJsonAtomic` is atomic per write,
 * but read-modify-write is not, and several subsystems write here (the floating
 * panel's resize handler already debounces into it).
 */
let writeChain: Promise<void> = Promise.resolve()

export function updateClientSettings(
  patch: Partial<ClientSettings>,
  dir: string = getClientRoot()
): Promise<ClientSettings> {
  const run = writeChain.then(() => {
    const path = clientSettingsPath(dir)
    const raw = readJsonObject(path) ?? {}
    const next = { ...raw, ...patch }
    writeJsonAtomic(path, next)
    return undefined
  })
  writeChain = run.catch(() => undefined)
  return run.then(() => readClientSettings(dir))
}
