/**
 * One-shot "reopen Settings on this tab after the window reloads".
 *
 * Some settings saves must reload the window — e.g. adding a hub: the renderer
 * CSP is fixed per document load, so only a fresh load admits the new hub's
 * origin (#161). The reload would otherwise drop the user out of Settings
 * right when the next step (signing in to that hub) lives there. sessionStorage
 * survives `location.reload()` and nothing else, so the request can't leak
 * into a later launch. Access is wrapped: storage can throw (blocked/disabled),
 * and losing the reopen is harmless.
 *
 * Reading and dropping the request are separate steps so the app can read it
 * while rendering (Settings opens in the first commit) and drop it only once that
 * render commits — see `useSettingsReopenTab`.
 */
const KEY = 'slayzone:settings-reopen-tab'

export function requestSettingsReopen(tab: string): void {
  try {
    sessionStorage.setItem(KEY, tab)
  } catch {
    /* storage unavailable — the reload still happens, Settings just stays closed */
  }
}

/** The requested tab, or null. Read-only: safe to call from a render, any number of times. */
export function peekSettingsReopen(): string | null {
  try {
    return sessionStorage.getItem(KEY) || null
  } catch {
    return null
  }
}

/** Drops the request, so it is acted on once. */
export function clearSettingsReopen(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* storage unavailable — nothing was stored either */
  }
}
