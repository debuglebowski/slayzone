import { deriveHubCredentialsKey } from '@slayzone/platform/hub-auth-secret'
import type { CredentialKeyRing } from '@slayzone/integrations/server'
import { HUB_CREDENTIALS_ENV } from '@slayzone/platform/hub-switches'

/**
 * The key this hub encrypts integration credentials under (decision D1).
 *
 *   1. An explicit secret (credentials-secret-input.ts). The desktop app always sends
 *      one, on a pipe: a per-install key it keeps wrapped with Electron safeStorage
 *      (its hub runs on the shared dev auth secret, which cannot protect anything),
 *      plus any older key it recovered. An operator may set
 *      `SLAYZONE_HUB_CREDENTIALS_SECRET`, to keep credentials readable across an
 *      auth-secret rotation.
 *   2. Otherwise HKDF of the hub auth secret (label `integrationCredentials`), so a
 *      standalone hub needs no new file and no new knob.
 *   3. Otherwise none (the shared dev secret is public, a key derived from it would
 *      be too): the store refuses to write, and reads only formats needing no key.
 *
 * With 1 and a real auth secret, the auth-secret key stays in `previous`: a hub that
 * started without the variable keeps reading its rows, and re-encrypts them under
 * the new key as it reads them.
 */
const MIN_SECRET_LENGTH = 32

export function resolveCredentialKeyRing(input: {
  /** The desktop's key or an operator's secret (credentials-secret-input.ts). */
  secret: string | null
  /** Older keys still to read (a desktop key set aside and recovered, review H2). */
  previousSecrets: readonly string[]
  hubAuthSecret: string
  devAuthSecret: string
}): CredentialKeyRing | null {
  const derived =
    input.hubAuthSecret && input.hubAuthSecret !== input.devAuthSecret
      ? deriveHubCredentialsKey(input.hubAuthSecret)
      : null
  if (input.secret) {
    if (input.secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `[slayzone-hub] ${HUB_CREDENTIALS_ENV.secret} must be at least ${MIN_SECRET_LENGTH} characters`
      )
    }
    const previous = input.previousSecrets.map((p) => deriveHubCredentialsKey(p))
    if (derived) previous.push(derived)
    return { current: deriveHubCredentialsKey(input.secret), previous }
  }
  return derived ? { current: derived } : null
}
