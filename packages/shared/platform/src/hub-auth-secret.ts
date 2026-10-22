/**
 * Values DERIVED from `SLAYZONE_HUB_AUTH_SECRET` instead of generated and written to
 * disk (T-11).
 *
 * A hub other machines can reach (B13) takes its auth secret from the environment
 * (B14) and writes no generated secret under `<ROOT>`. Where it still needs a
 * credential of its own, it derives one from that secret with HKDF-SHA256 and a label
 * that names the use, so the operator holds ONE secret and nothing new lands on disk.
 *
 * Why derivation is sound here:
 *   - HKDF (RFC 5869) is a key-derivation PRF: outputs for different labels are
 *     independent, and an output reveals neither the secret nor any other output. A
 *     derived password typed into a sign-in request, or stored scrypt-hashed by
 *     better-auth, exposes nothing about the signing key.
 *   - No other use of the secret is HKDF-SHA256 with these labels: better-auth signs
 *     cookies with HMAC-SHA256 keyed by the raw secret and encrypts OAuth tokens and
 *     JWT keys under SHA-256(secret). The derivations cannot collide with those keys.
 *   - The holder of the secret gains nothing new: the secret already decrypts every
 *     stored Entra token and the hub's JWT signing key. The operator, who put it in the
 *     environment, is the only party meant to hold it.
 *
 * Each label lives in {@link HUB_AUTH_SECRET_LABELS}, ONE table, so two uses can never
 * share a label by accident. A label is never reused for a different purpose: change
 * the version suffix instead.
 *
 * Lean leaf (node:crypto only) so the CLI can import it via the
 * `@slayzone/platform/hub-auth-secret` subpath without the platform barrel.
 *
 * @module platform/hub-auth-secret
 */
import { hkdfSync } from 'node:crypto'

/** Every value derived from the hub auth secret, by use. Distinct by construction. */
export const HUB_AUTH_SECRET_LABELS = {
  /** The bootstrap owner of a reachable password hub (apps/hub bootstrap-owner.ts). */
  bootstrapOwnerPassword: 'slayzone-hub/bootstrap-owner-password/v1'
} as const

export type HubAuthSecretLabel =
  (typeof HUB_AUTH_SECRET_LABELS)[keyof typeof HUB_AUTH_SECRET_LABELS]

/**
 * HKDF-SHA256 over the secret, no salt (the secret is a high-entropy key, RFC 5869
 * §3.1), with `label` as the info string.
 */
export function deriveFromHubAuthSecret(
  secret: string,
  label: HubAuthSecretLabel,
  bytes: number
): Buffer {
  if (!secret) throw new Error('[slayzone] cannot derive from an empty hub auth secret')
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), label, bytes))
}

/**
 * The bootstrap owner's password on a reachable password hub: 128 bits, base64url —
 * the same shape as a generated account password (hub-auth users.ts). The hub sets it
 * once, when it creates the owner; `slay hub owner-password` prints it for an operator
 * who holds the secret. A password changed afterwards is not derived any more.
 */
export function deriveBootstrapOwnerPassword(secret: string): string {
  return deriveFromHubAuthSecret(
    secret,
    HUB_AUTH_SECRET_LABELS.bootstrapOwnerPassword,
    16
  ).toString('base64url')
}
