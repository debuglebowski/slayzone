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

/** A credential an older desktop app encrypted with its OS keychain (safeStorage),
 *  which this hub cannot reach. */
export const CREDENTIAL_LEGACY_UNREADABLE_ERROR =
  "This credential was saved with the desktop app's keychain, which this hub can't reach — reconnect to continue."

const REASONS: readonly string[] = [
  CREDENTIAL_KEY_UNAVAILABLE_ERROR,
  CREDENTIAL_LEGACY_UNREADABLE_ERROR
]

/** The reason text when `authError` is a credential-key problem, else null. */
export function credentialReconnectReason(authError: string | null | undefined): string | null {
  return authError && REASONS.includes(authError) ? authError : null
}

/** Every reason the hub sets itself (and clears once the credential reads again). */
export const CREDENTIAL_RECONNECT_REASONS = REASONS
