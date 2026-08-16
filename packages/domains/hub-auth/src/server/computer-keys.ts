import { API_KEY_TABLE_NAME } from '@better-auth/api-key'
import type { HubAuth } from './auth'

/**
 * Internal service user that owns computer API keys — the api-key plugin
 * requires every key to reference a user. Created lazily on first mint.
 */
export const COMPUTER_SERVICE_USER_EMAIL = 'computers@slayzone.internal'

export interface MintComputerApiKeyInput {
  computerId: string
  /** Human-readable key label (e.g. hostname of the computer). */
  name: string
}

export interface MintedComputerApiKey {
  /** Plaintext key — only available at mint time; hand it to the computer. */
  key: string
  /** apikey row id — pass to `revokeComputerApiKey`. */
  keyId: string
  computerId: string
}

async function ensureComputerServiceUser(auth: HubAuth): Promise<string> {
  const ctx = await auth.$context
  const existing = await ctx.internalAdapter.findUserByEmail(COMPUTER_SERVICE_USER_EMAIL)
  if (existing) return existing.user.id
  const created = await ctx.internalAdapter.createUser({
    email: COMPUTER_SERVICE_USER_EMAIL,
    name: 'SlayZone Computer Service',
    emailVerified: true
  })
  return created.id
}

/**
 * The computer service user's id, or null when it does not exist yet.
 *
 * NON-CREATING, unlike {@link ensureComputerServiceUser} — this is the VERIFY
 * side. `verifyComputerApiKey` uses it to require that a key was minted by
 * {@link mintComputerApiKey} (which references this user) rather than by a
 * human's session through better-auth's own `/api/auth/api-key/create`. A
 * verify path must never create identity as a side effect, and a hub with no
 * service user has necessarily minted no computer keys — so null means "no key
 * can possibly be valid", which is the correct fail-closed answer.
 */
export async function findComputerServiceUserId(auth: HubAuth): Promise<string | null> {
  const ctx = await auth.$context
  const existing = await ctx.internalAdapter.findUserByEmail(COMPUTER_SERVICE_USER_EMAIL)
  return existing?.user.id ?? null
}

/**
 * Mint an API key for a computer. The computer identity is stored as
 * `{ computerId }` key metadata and resolved back by `verifyComputerApiKey`.
 * The key is stored hashed; the returned plaintext is shown exactly once.
 */
export async function mintComputerApiKey(
  auth: HubAuth,
  input: MintComputerApiKeyInput
): Promise<MintedComputerApiKey> {
  const userId = await ensureComputerServiceUser(auth)
  const created = await auth.api.createApiKey({
    body: {
      name: input.name,
      userId,
      metadata: { computerId: input.computerId }
    }
  })
  return { key: created.key, keyId: created.id, computerId: input.computerId }
}

/**
 * Revoke a computer API key by its row id. Returns false when no such key
 * exists. Goes through the adapter directly because the api-key plugin's
 * delete endpoint is session-bound and computer keys are managed server-side.
 */
export async function revokeComputerApiKey(auth: HubAuth, keyId: string): Promise<boolean> {
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
