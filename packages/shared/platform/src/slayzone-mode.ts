/**
 * `SLAYZONE_MODE` — the single hardening-intent flag for a standalone hub/runner.
 *
 *   local  (default) — loopback / dev: auth off, plaintext `ws` allowed, TLS optional.
 *   remote           — internet-facing: hub enforces client auth + TLS; runner
 *                      requires `wss` + a pinned cert. One flag flips the whole
 *                      secure bundle so an operator declares intent explicitly
 *                      instead of it being derived from a networking knob.
 *
 * Read by BOTH binaries, so it stays unprefixed (like SLAYZONE_ROOT). Kept a
 * lean leaf module (only ./dirs-free) so the runner bundle can import it without
 * the platform barrel.
 *
 * @module platform/slayzone-mode
 */

export type SlayzoneMode = 'local' | 'remote'

/** Loopback host literals — a bind to any of these is NOT network-exposed. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::'])

/** Resolve the deployment mode. Unknown/unset → `local` (the safe default). */
export function getSlayzoneMode(): SlayzoneMode {
  return process.env.SLAYZONE_MODE?.trim().toLowerCase() === 'remote' ? 'remote' : 'local'
}

/** True when running as an internet-facing deployment. */
export function isRemoteMode(): boolean {
  return getSlayzoneMode() === 'remote'
}

/** True when `host` is a loopback/link-local bind (not reachable off-box). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

/**
 * Fail-loud on the DANGEROUS mode/bind mismatch only:
 *   - `local` + non-loopback bind = exposed but UNHARDENED (auth off, ws) → throw.
 *   - `remote` + loopback bind = benign (e.g. behind a reverse proxy/tunnel) → ok.
 * Call once at hub boot after the client host is resolved.
 */
export function assertModeHostConsistency(mode: SlayzoneMode, host: string): void {
  if (mode === 'local' && !isLoopbackHost(host)) {
    throw new Error(
      `[slayzone] SLAYZONE_MODE=local but the client API binds to a non-loopback ` +
        `address (${host}) — that exposes an UNHARDENED hub (no auth, no TLS). ` +
        `Set SLAYZONE_MODE=remote to harden it, or bind to 127.0.0.1.`
    )
  }
}
