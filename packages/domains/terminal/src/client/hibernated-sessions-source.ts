/**
 * Where the terminal-state store reads the persisted hibernated-session set from.
 * The set is owned by `@slayzone/task-terminals` (its `taskTerminals` router),
 * which sits ABOVE terminal, so terminal never calls that router: the composing app
 * injects the source once via registerHibernatedSessionIdsSource() — task-terminals
 * ships the real one (`@slayzone/task-terminals/hibernated-sessions`).
 *
 * The source reads the DEFAULT hub's client (`getTrpcClient()`): `PtyProvider` is
 * only ever mounted under the default hub's provider (`TrpcProvider` / the default
 * `HubScope`), whose client IS that boot singleton.
 */
export type HibernatedSessionIdsSource = () => Promise<readonly string[]>

let registered: HibernatedSessionIdsSource | null = null

/**
 * Called ONCE by the composing app at module scope, before its first render.
 * Re-registering the same function is a no-op; a different one throws.
 */
export function registerHibernatedSessionIdsSource(source: HibernatedSessionIdsSource): void {
  if (registered && registered !== source) {
    throw new Error(
      'registerHibernatedSessionIdsSource: a hibernated-session source is already registered'
    )
  }
  registered = source
}

/** The app-registered source. Rejects if the app never registered one. */
export function listHibernatedSessionIds(): Promise<readonly string[]> {
  if (!registered) {
    return Promise.reject(
      new Error(
        'listHibernatedSessionIds: the app must call registerHibernatedSessionIdsSource first'
      )
    )
  }
  return registered()
}

/** Test-only: forget the registered source. */
export function _resetHibernatedSessionIdsSource(): void {
  registered = null
}
