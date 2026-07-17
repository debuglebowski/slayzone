import { mintTaskToken } from '@slayzone/hub-auth/server'
import type { RemoteMcpEnv } from '@slayzone/terminal/server'

/**
 * Synchronous remote-MCP-env provider — a narrowing of `@slayzone/terminal`'s
 * `RemoteMcpEnvProvider` (which permits a Promise return). This impl mints a
 * token + builds strings synchronously, so the narrower type lets callers/tests
 * read the result without awaiting; it stays assignable to the wider provider
 * type at the `setRemoteMcpEnvProvider` injection site (return covariance).
 */
export type SyncRemoteMcpEnvProvider = (args: {
  taskId: string | undefined
  runnerId: string
}) => RemoteMcpEnv | null

/**
 * TTL for a per-task hub bearer minted at PTY spawn (remote-MCP-env provider).
 * The token is baked into the runner-routed pty's env once, at spawn, and is
 * never refreshed for the life of that session — so it must comfortably outlive
 * a long working session (a remote agent can run for hours). 12h covers a full
 * workday while staying bounded; a mid-session refresh handshake is a follow-up.
 */
export const TASK_TOKEN_TTL_MS = 12 * 60 * 60 * 1000

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
 * hub's externally-reachable base URL and mints a scoped bearer.
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
 * The bearer is minted ONLY when a task is bound (a pooled/taskless spawn has no
 * task to scope to → `token: null`). `mintTaskToken` here + `verifyTaskToken` on
 * the agent-hook route MUST share the same `runnerTransportSecret`.
 */
export function createRemoteMcpEnvProvider(opts: {
  runnerTransportSecret: string
  getBoundPort: () => number
  ttlMs?: number
}): SyncRemoteMcpEnvProvider {
  const ttlMs = opts.ttlMs ?? TASK_TOKEN_TTL_MS
  return ({ taskId, runnerId }) => {
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
    const token =
      taskId != null
        ? mintTaskToken(opts.runnerTransportSecret, { taskId, runnerId, ttlMs })
        : null
    return { runnerId, hubBaseUrl, token }
  }
}
