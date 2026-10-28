/**
 * @module trpc-server/auth-gate
 */

/**
 * Multi-hub auth gate. Returns whether THIS hub enforces bearer auth on tRPC
 * procedures. Default `false` (trusted loopback / non-authed remote) → the auth
 * middleware is inert, byte-identical to the pre-auth server. The hub sets a
 * real predicate (`() => hubAuthRequired`) at boot — true when
 * `SLAYZONE_HUB_REQUIRE_LOGIN=1`.
 */
let authGate: () => boolean = () => false

export function setAuthGate(fn: () => boolean): void {
  authGate = fn
}

export function getAuthGate(): boolean {
  return authGate()
}
