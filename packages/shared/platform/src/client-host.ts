/**
 * The client host — the process on THIS device that owns what belongs to the device
 * and not to a hub: the theme mode, the labs flags, the keyboard-shortcut overrides,
 * the native menu and its accelerators, the app zoom and the auto-updater
 * (ARCHITECTURE.md, "client-local host work").
 *
 * The renderer reaches it directly — Electron main over preload IPC
 * (the preload's `clientHost`, app/src/main/client-host-ipc.ts), the web shell over
 * `localStorage`, the chromium shell over its Mojo key-value store
 * (`createStorageClientHost` below) — and never through a hub. A hub cannot answer
 * for a device it does not run on (a remote hub, a second machine), and a hub's
 * events must not drive this device's menu actions (a hostile hub could otherwise
 * trigger a screenshot of the active browser view or reload the app).
 *
 * Deliberately generic over the wire (`invoke(method, args)` + one event stream),
 * typed by `ClientHostMethods` / `ClientHostEvents` at both ends — the same shape as
 * the browser host (`ElectronBrowserHost`).
 *
 * Pure TypeScript, no Node or DOM imports: Electron main, both shells and the
 * renderer import it.
 */

export type ThemePreference = 'light' | 'dark' | 'system'
export type EffectiveTheme = 'dark' | 'light'
export type LabFlag = 'testsPanel' | 'loopMode'
export type ShortcutOverrideMap = Record<string, string | null>
export type ZoomCommand = 'in' | 'out' | 'reset'

/** Auto-updater progress (`update-status`). */
export type UpdateStatus =
  | { type: 'checking' }
  | { type: 'downloading'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'not-available' }
  | { type: 'error'; message: string }

/** Everything the device keeps for itself, in one read. */
export interface ClientSettingsSnapshot {
  /** The stored theme mode ('system' = follow the OS). */
  theme: ThemePreference
  /** What the mode resolves to right now. */
  effectiveTheme: EffectiveTheme
  labs: Record<LabFlag, boolean>
  /** Shortcut overrides; `null` = explicitly unbound. */
  shortcuts: ShortcutOverrideMap
  /**
   * This device's map is authoritative: the one-time copy of the hub's overrides
   * happened, or the person edited shortcuts here (D1). Either way the hub's map
   * must never overwrite it again.
   */
  shortcutsOwnedByDevice: boolean
}

export interface ClientHostMethods {
  'settings.snapshot': () => ClientSettingsSnapshot
  /** Apply + persist the mode; returns what it resolves to. */
  'theme.set': (preference: ThemePreference) => EffectiveTheme
  'labs.set': (flag: LabFlag, on: boolean) => void
  /**
   * Replace the whole override map. `adoptedFromHub` (the one-time copy) or
   * `localEdit` (the person changed a shortcut here) also sets
   * `shortcutsOwnedByDevice`, in the same write. A plain write (load-time
   * normalization) leaves it as it is.
   */
  'shortcuts.set': (
    overrides: ShortcutOverrideMap,
    opts?: { adoptedFromHub?: boolean; localEdit?: boolean }
  ) => void
  'zoom.get': () => number
  'zoom.adjust': (command: ZoomCommand) => number
  'update.restart': () => void
  'update.check': () => void
}
export type ClientHostMethod = keyof ClientHostMethods

export const CLIENT_HOST_METHODS = [
  'settings.snapshot',
  'theme.set',
  'labs.set',
  'shortcuts.set',
  'zoom.get',
  'zoom.adjust',
  'update.restart',
  'update.check'
] as const satisfies readonly ClientHostMethod[]

/** Event → payload (`undefined` = a bare signal). */
export interface ClientHostEvents {
  'go-home': undefined
  'toggle-global-agent-panel': undefined
  'toggle-agent-status-panel': undefined
  'open-settings': undefined
  'open-project-settings': undefined
  'new-temporary-task': undefined
  'screenshot-trigger': undefined
  'close-current-focus': undefined
  'close-active-task': undefined
  'sync-session-id': undefined
  'reload-browser': undefined
  'reload-app': undefined
  'zoom-factor-changed': number
  /** Sticky: the host replays the last one to a renderer that subscribes later. */
  'update-status': UpdateStatus
  /** A `slayzone://task/<id>` link opened on this device. */
  'open-task': { taskId: string; background?: boolean }
  /** Theme, labs or shortcuts changed (any window, or the OS dark/light toggle). */
  'settings-changed': ClientSettingsSnapshot
}
export type ClientHostEvent = keyof ClientHostEvents

export const CLIENT_HOST_EVENTS = [
  'go-home',
  'toggle-global-agent-panel',
  'toggle-agent-status-panel',
  'open-settings',
  'open-project-settings',
  'new-temporary-task',
  'screenshot-trigger',
  'close-current-focus',
  'close-active-task',
  'sync-session-id',
  'reload-browser',
  'reload-app',
  'zoom-factor-changed',
  'update-status',
  'open-task',
  'settings-changed'
] as const satisfies readonly ClientHostEvent[]

/** Electron-style listener args per event (for a `TypedEmitter`). */
export type ClientEventMap = {
  [E in ClientHostEvent]: ClientHostEvents[E] extends undefined ? [] : [ClientHostEvents[E]]
}

/**
 * The raw, untyped surface each shell installs as the `clientHost` of its `api` global.
 * `@slayzone/transport/client`'s `getClientHost()` is the typed reader.
 */
export interface ElectronClientHost {
  /** One `ClientHostMethods` call. */
  invoke: (method: string, args: unknown[]) => Promise<unknown>
  /** Every host event. The first listener subscribes this renderer; it then gets the
   *  last `update-status` (if any) before live events. */
  on: (listener: (event: string, payload: unknown) => void) => () => void
}

// ── storage-backed host (web shell, chromium shell) ─────────────────────────────

/** A string key-value store, sync (`localStorage`) or async (Mojo KV). */
export interface ClientHostKv {
  get: (key: string) => string | null | Promise<string | null>
  set: (key: string, value: string) => void | Promise<void>
}

const KEY = {
  theme: 'slayzone:client:theme',
  labs: 'slayzone:client:labs',
  shortcuts: 'slayzone:client:shortcuts',
  adopted: 'slayzone:client:shortcuts-owned-by-device'
} as const

const parseJson = (raw: string | null): unknown => {
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const asTheme = (v: unknown): ThemePreference =>
  v === 'light' || v === 'dark' || v === 'system' ? v : 'system'

/**
 * A client host over a key-value store, for a shell with no native process of its
 * own to hold device settings. Theme, labs and shortcuts persist in the store;
 * there is no native menu, app zoom (the browser owns it) or updater, so those are
 * inert. Events are local to this page: `settings-changed` after each write.
 *
 * Defaults match what those shells showed before: theme 'system', labs off.
 */
export function createStorageClientHost(opts: {
  kv: ClientHostKv
  /** The OS scheme, for 'system' (`prefers-color-scheme`). */
  systemTheme: () => EffectiveTheme
}): ElectronClientHost {
  const { kv } = opts
  const listeners = new Set<(event: string, payload: unknown) => void>()
  const emit = (event: ClientHostEvent, payload: unknown): void => {
    for (const l of [...listeners]) l(event, payload)
  }

  const snapshot = async (): Promise<ClientSettingsSnapshot> => {
    const [theme, labs, shortcuts, adopted] = await Promise.all([
      kv.get(KEY.theme),
      kv.get(KEY.labs),
      kv.get(KEY.shortcuts),
      kv.get(KEY.adopted)
    ])
    const pref = asTheme(theme)
    const l = parseJson(labs)
    const s = parseJson(shortcuts)
    const map: ShortcutOverrideMap = {}
    if (isRecord(s)) {
      for (const [k, v] of Object.entries(s)) if (typeof v === 'string' || v === null) map[k] = v
    }
    return {
      theme: pref,
      effectiveTheme: pref === 'system' ? opts.systemTheme() : pref,
      labs: {
        testsPanel: isRecord(l) && l.testsPanel === true,
        loopMode: isRecord(l) && l.loopMode === true
      },
      shortcuts: map,
      shortcutsOwnedByDevice: adopted === '1'
    }
  }

  const changed = async (): Promise<void> => emit('settings-changed', await snapshot())

  const methods: { [K in ClientHostMethod]: (...args: never[]) => unknown } = {
    'settings.snapshot': () => snapshot(),
    'theme.set': async (pref: ThemePreference) => {
      const next = asTheme(pref)
      await kv.set(KEY.theme, next)
      await changed()
      return next === 'system' ? opts.systemTheme() : next
    },
    'labs.set': async (flag: LabFlag, on: boolean) => {
      const { labs } = await snapshot()
      await kv.set(KEY.labs, JSON.stringify({ ...labs, [flag]: on === true }))
      await changed()
    },
    'shortcuts.set': async (
      overrides: ShortcutOverrideMap,
      o?: { adoptedFromHub?: boolean; localEdit?: boolean }
    ): Promise<void> => {
      await kv.set(KEY.shortcuts, JSON.stringify(isRecord(overrides) ? overrides : {}))
      if (o?.adoptedFromHub || o?.localEdit) await kv.set(KEY.adopted, '1')
      await changed()
    },
    'zoom.get': () => 1,
    'zoom.adjust': () => 1,
    'update.restart': () => undefined,
    'update.check': () => undefined
  }

  return {
    invoke: async (method, args) => {
      const fn = (methods as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>)[
        method
      ]
      if (!Object.hasOwn(methods, method) || !fn) {
        throw new Error(`client host: unknown method ${method}`)
      }
      return await fn(...(Array.isArray(args) ? args : []))
    },
    on: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
