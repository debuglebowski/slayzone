import { hubUrlFromAddr, isBareAuthority } from '@slayzone/platform/hub-addr'
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
 * Turn the operator-supplied hub PUBLIC ADDRESS (`host[:port]`, no scheme, no
 * path) into the http(s) base URL the RemoteMcpEnv contract wants. The scheme is
 * DERIVED from SLAYZONE_MODE, never carried in the value — so this base URL and
 * the runner's `ws(s)://…/runners` can never disagree about it.
 *
 * Returns null for a value that is not a bare authority (a scheme or path snuck
 * in), so the provider degrades the spawn to loopback rather than handing a broken
 * base URL to the remote pty's `slay` CLI.
 *
 * NOTE: authority-only means a path-prefixed reverse-proxy mount
 * (`https://host/slayzone`) is not expressible here. Nothing consumes such a
 * prefix today — deriveRunnerHubUrl forces `/runners` and this base URL is only
 * ever concatenated with absolute `/api/...` paths.
 */
function publicHubBaseUrl(raw: string): string | null {
  if (!isBareAuthority(raw)) return null
  return hubUrlFromAddr(raw, 'http')
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
 *   - `SLAYZONE_HUB_PUBLIC_ADDRESS` (operator-supplied `host[:port]`, scheme from
 *     SLAYZONE_MODE) — REQUIRED for a truly-remote runner, which can't reach the
 *     hub's loopback.
 *   - else `http://127.0.0.1:<boundPort>` — reachable only by a co-located /
 *     loopback runner; the safe default for a local runner.
 *   - else (port not bound yet, no public address) → `null`, so
 *     `resolveRemoteMcpEnv` degrades the spawn to loopback env rather than emitting
 *     an unreachable hub target. A real remote deployment MUST set
 *     SLAYZONE_HUB_PUBLIC_ADDRESS.
 *
 * No per-task bearer is minted: the agent lifecycle hook posts to the runner's
 * OWN loopback `/api/agent-hook` relay (forwarded to the hub over the authed ws
 * channel), so no bearer ever rides in the agent subprocess env.
 */
export function createRemoteMcpEnvProvider(opts: {
  getBoundPort: () => number
}): SyncRemoteMcpEnvProvider {
  return ({ runnerId }) => {
    const publicAddress = process.env.SLAYZONE_HUB_PUBLIC_ADDRESS?.trim()
    const boundPort = opts.getBoundPort()
    // A set-but-malformed public address resolves to null (→ loopback fallback via
    // resolveRemoteMcpEnv), NOT to the loopback base: the operator explicitly
    // asked for a remote base, so silently substituting loopback (unreachable
    // from a truly-remote runner) would be worse than degrading via the null path.
    const hubBaseUrl = publicAddress
      ? publicHubBaseUrl(publicAddress)
      : boundPort
        ? `http://127.0.0.1:${boundPort}`
        : null
    // No reachable base (port not bound yet, no/invalid public address) → null so
    // the seam degrades to loopback instead of emitting an unreachable hub target.
    if (!hubBaseUrl) return null
    return { runnerId, hubBaseUrl }
  }
}
