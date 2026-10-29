import type { HubThemeSettings } from './native-theme'
import type { StoredAppTheme } from './selection'

/**
 * The theme inputs a client last read from each hub, kept between launches so the next
 * one paints in the user's theme before the hub answers: the React Native app's
 * counterpart of desktop's first-paint cache (`@slayzone/settings` `theme-cache.ts`).
 *
 * Kept as the hub's own settings (`HubThemeSettings`), not the colours they resolved
 * to: each launch resolves them again (`resolveNativeTheme`), so `system` follows the
 * device's light/dark of THAT launch and the colours are always this build's presets.
 *
 * The platform owns the storage (`HubThemeCacheStorage`: one text value), this module
 * the format: `{ v, last?, hubs: { [hubId]: HubThemeSettings } }`, where `last` is the
 * hub whose settings were saved most recently (the one signed in), so a launch can paint
 * before it even knows the session. Whatever it cannot read
 * (corrupt, another version, the wrong shape, storage that throws) counts as nothing
 * kept, so the default preset until the hub answers; a bad entry costs only its hub.
 */

/** The platform storage holding the cache: one text value. Either call may throw. */
export interface HubThemeCacheStorage {
  /** The text last written; null = none. */
  read(): string | null
  write(text: string): void
}

export interface HubThemeCache {
  /** The settings last kept for this hub; null = none, or unreadable. */
  load(hubId: string): HubThemeSettings | null
  /**
   * The settings of the hub saved most recently, for the paint before the app knows its
   * session (the keychain read); null = none, signed out of it, or unreadable.
   */
  loadLast(): HubThemeSettings | null
  /** Keep the settings just read from this hub, for the next launch; it becomes `last`. */
  save(hubId: string, settings: HubThemeSettings): void
  /** Drop what was kept for this hub (sign-out), and `last` if it names this hub. */
  forget(hubId: string): void
}

/**
 * What a client paints with: the hub's live settings once they have loaded; until then
 * the ones kept at the last launch (null = neither: the default preset).
 */
export function pickHubThemeSettings(
  live: HubThemeSettings | null,
  cached: HubThemeSettings | null
): HubThemeSettings | null {
  return live ?? cached
}

/** Bump when the stored shape changes: any other version reads as nothing kept. */
const VERSION = 1

export function createHubThemeCache(storage: HubThemeCacheStorage): HubThemeCache {
  return {
    load: (hubId) => readFile(storage).hubs.get(hubId) ?? null,
    loadLast: () => {
      const { last, hubs } = readFile(storage)
      return last === null ? null : (hubs.get(last) ?? null)
    },
    save: (hubId, settings) => {
      const { hubs } = readFile(storage)
      hubs.set(hubId, settings)
      writeFile(storage, { last: hubId, hubs })
    },
    forget: (hubId) => {
      const file = readFile(storage)
      if (!file.hubs.delete(hubId)) return
      writeFile(storage, { last: file.last === hubId ? null : file.last, hubs: file.hubs })
    }
  }
}

/** The readable content: `last` (null = none) and every readable entry, by hub id. */
interface CacheFile {
  last: string | null
  /** A Map: a hub id is only ever a key. */
  hubs: Map<string, HubThemeSettings>
}

function readFile(storage: HubThemeCacheStorage): CacheFile {
  const empty: CacheFile = { last: null, hubs: new Map() }
  let file: unknown
  try {
    const text = storage.read()
    if (!text) return empty
    file = JSON.parse(text)
  } catch {
    return empty
  }
  if (!isRecord(file) || file.v !== VERSION || !isRecord(file.hubs)) return empty
  const hubs = new Map<string, HubThemeSettings>()
  for (const [hubId, entry] of Object.entries(file.hubs)) {
    const settings = parseSettings(entry)
    if (settings) hubs.set(hubId, settings)
  }
  return { last: typeof file.last === 'string' ? file.last : null, hubs }
}

function writeFile(storage: HubThemeCacheStorage, { last, hubs }: CacheFile): void {
  try {
    const file = { v: VERSION, ...(last === null ? {} : { last }), hubs: Object.fromEntries(hubs) }
    storage.write(JSON.stringify(file))
  } catch {
    // Only a cache: the next launch starts in the default preset, as without one.
  }
}

/** The entry's settings, checked field by field (values as the hub said them); else null. */
function parseSettings(entry: unknown): HubThemeSettings | null {
  if (!isRecord(entry) || !isText(entry.preference) || !isRecord(entry.stored)) return null
  const { themeId, split, themeIdDark, themeIdLight, legacyThemeId } = entry.stored
  if (!isText(themeId) || !isText(split) || !isText(themeIdDark) || !isText(themeIdLight)) {
    return null
  }
  const stored: StoredAppTheme = { themeId, split, themeIdDark, themeIdLight }
  if (legacyThemeId !== undefined) {
    if (!isText(legacyThemeId)) return null
    stored.legacyThemeId = legacyThemeId
  }
  return { preference: entry.preference, stored }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A setting's value: a string, or null (unset). */
function isText(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}
