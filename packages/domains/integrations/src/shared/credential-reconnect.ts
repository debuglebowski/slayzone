/**
 * Why a connection asks to reconnect when the hub cannot decrypt its stored
 * credential (integrations server credentials.ts). Set on the connection's
 * `auth_error`, shown as is by the Integrations UI: the user learns WHY, not only
 * that authentication "expired".
 */

/** A `hub1:` credential under a key this hub does not hold (e.g. the desktop's key
 *  file restored onto another machine, whose keychain cannot unwrap it). */
export const CREDENTIAL_KEY_UNAVAILABLE_ERROR =
  "This hub's key isn't available on this machine — reconnect to continue."

/** The desktop has not unlocked this hub's key from the OS keychain yet (a prompt not
 *  answered, access denied): reconnecting cannot help until it is (review-2 L4). */
export const CREDENTIAL_KEY_LOCKED_ERROR =
  "SlayZone hasn't unlocked this hub's key from the OS keychain. Allow keychain access, or restart SlayZone."

/** A standalone hub: the key derives from its auth secret (or an operator's credentials
 *  secret), so a row under another key means one of those changed (review L5). */
export const CREDENTIAL_KEY_CHANGED_ERROR =
  'Saved under a different hub key (SLAYZONE_HUB_AUTH_SECRET or SLAYZONE_HUB_CREDENTIALS_SECRET changed) — reconnect to continue.'

/** A credential an older desktop app encrypted with its OS keychain (safeStorage),
 *  which this hub cannot reach. */
export const CREDENTIAL_LEGACY_UNREADABLE_ERROR =
  "This credential was saved with the desktop app's keychain, which this hub can't reach — reconnect to continue."

const REASONS: readonly string[] = [
  CREDENTIAL_KEY_UNAVAILABLE_ERROR,
  CREDENTIAL_KEY_LOCKED_ERROR,
  CREDENTIAL_KEY_CHANGED_ERROR,
  CREDENTIAL_LEGACY_UNREADABLE_ERROR
]

/** The reason text when `authError` is a credential-key problem, else null. */
export function credentialReconnectReason(authError: string | null | undefined): string | null {
  return authError && REASONS.includes(authError) ? authError : null
}

/** Every reason the hub sets itself (and clears once the credential reads again). */
export const CREDENTIAL_RECONNECT_REASONS = REASONS
