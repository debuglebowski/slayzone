import { API_KEY_TABLE_NAME } from '@better-auth/api-key'
import type { HubAuth } from './auth'

/**
 * Internal service user that owns runner API keys — the api-key plugin
 * requires every key to reference a user. Created lazily on first mint.
 */
export const RUNNER_SERVICE_USER_EMAIL = 'runners@slayzone.internal'

export interface MintRunnerApiKeyInput {
  runnerId: string
  /** Human-readable key label (e.g. hostname of the runner). */
  name: string
}

export interface MintedRunnerApiKey {
  /** Plaintext key — only available at mint time; hand it to the runner. */
  key: string
  /** apikey row id — pass to `revokeRunnerApiKey`. */
  keyId: string
  runnerId: string
}

async function ensureRunnerServiceUser(auth: HubAuth): Promise<string> {
  const ctx = await auth.$context
  const existing = await ctx.internalAdapter.findUserByEmail(RUNNER_SERVICE_USER_EMAIL)
  if (existing) return existing.user.id
  const created = await ctx.internalAdapter.createUser({
    email: RUNNER_SERVICE_USER_EMAIL,
    name: 'SlayZone Runner Service',
    emailVerified: true
  })
  return created.id
}

/**
 * Mint an API key for a runner. The runner identity is stored as
 * `{ runnerId }` key metadata and resolved back by `verifyRunnerApiKey`.
 * The key is stored hashed; the returned plaintext is shown exactly once.
 */
export async function mintRunnerApiKey(
  auth: HubAuth,
  input: MintRunnerApiKeyInput
): Promise<MintedRunnerApiKey> {
  const userId = await ensureRunnerServiceUser(auth)
  const created = await auth.api.createApiKey({
    body: {
      name: input.name,
      userId,
      metadata: { runnerId: input.runnerId }
    }
  })
  return { key: created.key, keyId: created.id, runnerId: input.runnerId }
}

/**
 * Revoke a runner API key by its row id. Returns false when no such key
 * exists. Goes through the adapter directly because the api-key plugin's
 * delete endpoint is session-bound and runner keys are managed server-side.
 */
export async function revokeRunnerApiKey(auth: HubAuth, keyId: string): Promise<boolean> {
  const ctx = await auth.$context
  const existing = await ctx.adapter.findOne<{ id: string }>({
    model: API_KEY_TABLE_NAME,
    where: [{ field: 'id', value: keyId }]
  })
  if (!existing) return false
  await ctx.adapter.delete({
    model: API_KEY_TABLE_NAME,
    where: [{ field: 'id', value: keyId }]
  })
  return true
}
