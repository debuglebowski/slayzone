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
 * created (to avoid a flash), the native menu and its key matcher are built from
 * `customShortcuts` and the `labs` flags, and the floating panel's geometry is a
 * property of this display. None of them can wait for a round trip to a server that
 * may not be running, or may be in another country.
 *
 * The renderer reads and writes theme, labs and shortcuts through the client host
 * (`./client-host.ts`, main's `client-host-ipc.ts`) — never through a hub.
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
  /** AUTHORITATIVE — keyboard-shortcut overrides: the native menu accelerators,
   *  built pre-hub, and every window's shortcut store. Per-machine. */
  customShortcuts?: Record<string, string | null>
  /**
   * `customShortcuts` here is authoritative: the one-time copy of the default hub's
   * `custom_shortcuts` happened (`adoptShortcutsFromHub`), or the person edited
   * shortcuts on this device. Written in the SAME patch as the map. A failed hub read
   * leaves it unset (the copy retries next boot) unless a local edit set it — a local
   * edit is never overwritten by the hub's older map.
   */
  shortcutsOwnedByDevice?: boolean
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

// `<role>.config.json`, like `hub.config.json` / `computer.config.json`: user-set
// values. (Also holds a little app-written state — panel geometry, a dialog-shown
// flag — not worth a second `client.state.json`.)
const FILE_NAME = 'client.config.json'

/** The name beta.14–18 wrote. Only ever a read-only source of a one-time copy. */
const LEGACY_FILE_NAME = 'client-settings.json'

export function clientSettingsPath(dir: string = getClientRoot()): string {
  return join(dir, FILE_NAME)
}

/**
 * One-time COPY of a beta-era `client-settings.json` to the new name. Lives here,
 * not in a boot-time migration, because the DB→file migration is sentinel-gated and
 * beta users already carry that sentinel: nothing else would ever restore their
 * theme/shortcuts/labs if the new name simply started empty. Every reader and writer
 * goes through `readClientSettings`/`updateClientSettings`, so this runs before any
 * of them regardless of call order.
 *
 * Same rules as the other migrations: COPY-ONLY (the old file is never modified,
 * renamed or deleted — a downgrade to a beta still finds it), and the new file always
 * wins. Parsed and re-written rather than byte-copied so it reuses the atomic 0600
 * writer; unknown fields survive because the whole raw object is kept. An unparseable
 * old file is left alone untouched, not adopted.
 */
function adoptLegacyFile(dir: string): void {
  const next = clientSettingsPath(dir)
  if (existsSync(next)) return
  const legacy = join(dir, LEGACY_FILE_NAME)
  if (!existsSync(legacy)) return
  const raw = readJsonObject(legacy)
  if (raw === null) return
  try {
    writeJsonAtomic(next, raw)
  } catch {
    /* best-effort — retried on the next read/update, never blocks boot */
  }
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
  if (raw.shortcutsOwnedByDevice === true) out.shortcutsOwnedByDevice = true
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
    out.cli = {
      migrationDialogShown: asBool((raw.cli as Record<string, unknown>).migrationDialogShown)
    }
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
  adoptLegacyFile(dir)
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
  return updateClientSettingsWith(() => patch, dir).then((r) => r.settings)
}

/**
 * Read-modify-write on the same serialized chain: `decide` sees the CURRENT file (as
 * parsed settings) and returns the patch, or null to write nothing. That makes a
 * check-and-set atomic against every other writer in this process.
 */
function updateClientSettingsWith(
  decide: (current: ClientSettings) => Partial<ClientSettings> | null,
  dir: string
): Promise<{ settings: ClientSettings; applied: boolean }> {
  const run = writeChain.then(() => {
    adoptLegacyFile(dir)
    const path = clientSettingsPath(dir)
    const raw = readJsonObject(path) ?? {}
    const patch = decide(coerce(raw))
    if (patch === null) return false
    writeJsonAtomic(path, { ...raw, ...patch })
    return true
  })
  writeChain = run.then(
    () => undefined,
    () => undefined
  )
  return run.then((applied) => ({ settings: readClientSettings(dir), applied }))
}

/**
 * Write the shortcut-override map. `localEdit` (the person changed a shortcut here)
 * and `adoptedFromHub` (the one-time copy) both set `shortcutsOwnedByDevice` in the
 * same write. The adoption is compare-and-set: once the device owns the map, an
 * adoption write is a no-op (`applied: false`) — so a second window's adoption, which
 * read the hub before this window's edit, can never overwrite that edit.
 */
export function writeClientShortcuts(
  overrides: Record<string, string | null>,
  opts: { adoptedFromHub?: boolean; localEdit?: boolean },
  dir: string = getClientRoot()
): Promise<{ settings: ClientSettings; applied: boolean }> {
  return updateClientSettingsWith((current) => {
    if (opts.adoptedFromHub && current.shortcutsOwnedByDevice) return null
    return {
      customShortcuts: overrides,
      ...(opts.adoptedFromHub || opts.localEdit ? { shortcutsOwnedByDevice: true } : {})
    }
  }, dir)
}
