import type { RemoteMcpEnv } from '@slayzone/terminal/server'

/**
 * Synchronous remote-MCP-env provider — a narrowing of `@slayzone/terminal`'s
 * `RemoteMcpEnvProvider` (which permits a Promise return). This impl builds
 * strings synchronously, so the narrower type lets callers/tests read the result
 * without awaiting; it stays assignable to the wider provider type at the
 * `setRemoteMcpEnvProvider` injection site (return covariance).
 */
export type SyncRemoteMcpEnvProvider = (args: {
  taskId: string | undefined
  runnerId: string
}) => RemoteMcpEnv | null

/**
 * Normalize + validate an operator-supplied hub base URL: require an http(s)
 * origin and strip trailing slashes (RemoteMcpEnv contract). Returns null for a
 * malformed value (missing scheme, not a URL) so the provider degrades the spawn
 * to loopback rather than injecting a broken `SLAYZONE_HUB_URL` into the remote
 * pty. Mirrors the CLI's `normalizeHubUrl` without importing across the app
 * boundary (apps/hub must not depend on apps/cli).
 */
function normalizePublicHubUrl(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
}

/**
 * Build the remote-MCP-env provider the composition root injects under runner
 * mode (hub/runner split, wave 3.5). Extracted from the composition root so it's
 * a pure, directly-testable function: given a task + runner it resolves the
 * hub's externally-reachable base URL (used ONLY by the `slay` CLI's hub REST
 * access — the agent HOOK posts to the runner's own loopback relay, not here).
 *
 * `getBoundPort` is read LAZILY (at every call) because the server host binds
 * the port AFTER composeServer returns (`setBoundPort` from server.ts) — it's 0
 * until then. hubBaseUrl derivation:
 *   - `SLAYZONE_HUB_PUBLIC_URL` (operator-supplied, trailing slash stripped) —
 *     REQUIRED for a truly-remote runner, which can't reach the hub's loopback.
 *   - else `http://127.0.0.1:<boundPort>` — reachable only by a co-located /
 *     loopback runner; the safe default for local-runner dogfooding.
 *   - else (port not bound yet, no public URL) → `null`, so `resolveRemoteMcpEnv`
 *     degrades the spawn to loopback env rather than emitting an unreachable hub
 *     target. A real remote deployment MUST set SLAYZONE_HUB_PUBLIC_URL.
 *
 * No per-task bearer is minted: the agent lifecycle hook posts to the runner's
 * OWN loopback `/api/agent-hook` relay (forwarded to the hub over the authed ws
 * channel), so no bearer ever rides in the agent subprocess env.
 */
export function createRemoteMcpEnvProvider(opts: {
  getBoundPort: () => number
}): SyncRemoteMcpEnvProvider {
  return ({ runnerId }) => {
    const publicUrl = process.env.SLAYZONE_HUB_PUBLIC_URL?.trim()
    const boundPort = opts.getBoundPort()
    // A set-but-malformed public URL resolves to null (→ loopback fallback via
    // resolveRemoteMcpEnv), NOT to the loopback base: the operator explicitly
    // asked for a remote base, so silently substituting loopback (unreachable
    // from a truly-remote runner) would be worse than degrading via the null
    // path. normalizePublicHubUrl also strips the trailing slash (contract).
    const hubBaseUrl = publicUrl
      ? normalizePublicHubUrl(publicUrl)
      : boundPort
        ? `http://127.0.0.1:${boundPort}`
        : null
    // No reachable base (port not bound yet, no/invalid public URL) → null so the
    // seam degrades to loopback instead of emitting an unreachable hub target.
    if (!hubBaseUrl) return null
    return { runnerId, hubBaseUrl }
  }
}
