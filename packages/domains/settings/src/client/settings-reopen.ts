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
 */
const KEY = 'slayzone:settings-reopen-tab'

export function requestSettingsReopen(tab: string): void {
  try {
    sessionStorage.setItem(KEY, tab)
  } catch {
    /* storage unavailable — the reload still happens, Settings just stays closed */
  }
}

/** Returns the requested tab once (and clears it), or null. */
export function consumeSettingsReopen(): string | null {
  try {
    const tab = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    return tab || null
  } catch {
    return null
  }
}
