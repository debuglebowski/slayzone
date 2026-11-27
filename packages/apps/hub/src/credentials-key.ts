import { deriveHubCredentialsKey } from '@slayzone/platform/hub-auth-secret'
import type { CredentialKeyRing } from '@slayzone/integrations/server'

/**
 * The key this hub encrypts integration credentials under (decision D1).
 *
 *   1. `SLAYZONE_HUB_CREDENTIALS_SECRET`, when set. The desktop app always sets it: a
 *      per-install key it keeps wrapped with Electron safeStorage (its hub runs on the
 *      shared dev auth secret, which cannot protect anything). An operator may set it
 *      too, to keep credentials readable across an auth-secret rotation.
 *   2. Otherwise HKDF of the hub auth secret (label `integrationCredentials`), so a
 *      standalone hub needs no new file and no new knob.
 *   3. Otherwise none (the shared dev secret is public, a key derived from it would
 *      be too): the store refuses to write, and reads only formats needing no key.
 *
 * With 1 and a real auth secret, the auth-secret key stays in `previous`: a hub that
 * started without the variable keeps reading its rows, and re-encrypts them under
 * the new key as it reads them.
 */
export const HUB_CREDENTIALS_SECRET_ENV = 'SLAYZONE_HUB_CREDENTIALS_SECRET'
const MIN_SECRET_LENGTH = 32

export function resolveCredentialKeyRing(input: {
  env: NodeJS.ProcessEnv
  hubAuthSecret: string
  devAuthSecret: string
}): CredentialKeyRing | null {
  const derived =
    input.hubAuthSecret && input.hubAuthSecret !== input.devAuthSecret
      ? deriveHubCredentialsKey(input.hubAuthSecret)
      : null
  const explicit = input.env[HUB_CREDENTIALS_SECRET_ENV]
  if (explicit !== undefined && explicit !== '') {
    if (explicit.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `[slayzone-hub] ${HUB_CREDENTIALS_SECRET_ENV} must be at least ${MIN_SECRET_LENGTH} characters`
      )
    }
    return { current: deriveHubCredentialsKey(explicit), previous: derived ? [derived] : [] }
  }
  return derived ? { current: derived } : null
}
