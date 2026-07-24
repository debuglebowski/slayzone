# Collapse hub to one mode-driven listener/port

## Goal (agreed end state)

One lever — `SLAYZONE_MODE` — decides protocol for the WHOLE hub. No per-listener
protocol/port knobs. Simplest end state, effort irrelevant.

- `local` (default): ONE plain `http`/`ws` listener on `SLAYZONE_HUB_HOST:SLAYZONE_HUB_PORT`.
- `remote`: ONE `https`/`wss` listener (hub identity leaf) on the same host:port.

The single listener path-demuxes: `/trpc` (clients, origin-guarded), `/runners`
(runners, no-origin), `/health`, `/api/*`, `/mcp`, REST-proxy.

Constraint that makes this safe: runner-remote ⟹ hub-remote (never a remote runner
on a local hub). So the hub's own mode fully determines every link's protocol.

## Var set (4→3, + deletions)

| Keep | Was |
|------|-----|
| `SLAYZONE_MODE` | (exists) |
| `SLAYZONE_HUB_HOST` | `SLAYZONE_SERVER_HOST` |
| `SLAYZONE_HUB_PORT` | `SLAYZONE_SERVER_PORT` |
| `SLAYZONE_HUB_PUBLIC_URL` | (exists) |

Deleted entirely:
- `SLAYZONE_HUB_TLS_PORT` — protocol implied by mode, never a separate port.
- `SLAYZONE_HUB_RUNNER_TRANSPORT_PORT` — `/runners` rides the shared port.
- `SLAYZONE_HUB_RUNNER_TRANSPORT_HOST` — one listener, one bind host.
- `settings.runner_transport_port` persistence layer (`resolveDesiredRunnerPort`,
  `claimRunnerServerPort`) — existed ONLY to keep the runner URL port stable across
  reboots; now the port IS the hub port, already stabilized by `claimServerPort` /
  `SIDECAR_FIXED_PORT`. Vestigial → delete.

DB key `settings.server_port` (CLI discovery channel) is NOT an env var — untouched
(rename would need a migration; out of scope).

## Why the runner needs no code change

Runner is entirely URL-driven (join token / `SLAYZONE_HUB_URL`). Both `/trpc`-TLS and
`/runners` already share the SAME hub identity leaf → fingerprint unchanged. The only
identity-breaking variable is the port in the URL (credential key = `host_port`).
Collapse changes that port ONCE → one-time re-key:
- supervised/local runner is name-keyed on the hub (UPSERT dedup) → benign re-enroll.
- remote runner re-enrolls with its join token (already required).

Runner-listener must advertise `ws://` in local, `wss://` in remote (today hardcodes wss).

## Why the client needs almost no change

- `/trpc` scheme decided per-URL in `boot-config.ts:normalizeRemoteUrl`; local hardcoded
  `ws://127.0.0.1:<port>`. Collapse doesn't change client scheme logic — operator points
  `remote_server_url` at the single port.
- `SLAYZONE_HUB_TLS_PORT` has zero client consumers.
- Only client-side edits: rename `SLAYZONE_SERVER_PORT` refs in `cli/src/db.ts` +
  `sidecar-server-supervisor.ts` (env injection).

## Implementation order

1. Rename `SLAYZONE_SERVER_PORT`→`SLAYZONE_HUB_PORT`, `SLAYZONE_SERVER_HOST`→`SLAYZONE_HUB_HOST`
   across all tracked files (mechanical; exact unique tokens, no substring collisions).
2. `server.ts`: build ONE `createServer`/`createHttpsServer` by mode; single `noServer`
   WSS demux for `/trpc` + `/runners` on `upgrade`; delete `tlsHttpsServer`/`tlsWss`/
   `runnerHttpsServer`/separate binds. Preserve origin-guard on `/trpc`, cert-pin
   (leaf) in remote, remote fail-loud guards.
3. `runner-listener.ts`: advertise scheme by mode; drop the separate-port machinery
   (fold the runner URL build into the shared bound port).
4. `port-claim.ts`: delete `resolveDesiredRunnerPort` + `claimRunnerServerPort` +
   `runner_transport_port`. Keep `claimServerPort`.
5. `standalone-config.ts` / `slayzone-config.ts`: drop `runnerTransportPort`
   seeding+field. Rename port/host doc.
6. `paths.ts`: `getTrpcPort`/`getServerHost` read the new names.
7. Fix tests asserting deleted vars (standalone-config.test, runner-restart-survival,
   runner-tls-listener) + rename-only test/e2e/script/doc churn.
8. `pnpm typecheck` + targeted unit tests + relevant e2e.

## Done

All steps landed. `pnpm typecheck` green across every package; touched unit tests
pass (port-claim, runner-tls-listener, runner-restart-survival, standalone-config,
mcp-env). Client needed NO code change — `/trpc` scheme is per-URL (local hardcoded
`ws://`, remote = operator `wss://`), and `SLAYZONE_HUB_TLS_PORT` had zero client
consumers. Scripts (publish-hub-runner) + stale main-process comment updated.

Resolved as designed:
- Deleted the `runner_transport_port` persistence layer (vestigial under one-port —
  the runner credential key is now stable via the shared, per-env-fixed hub port).
- Deleted `SLAYZONE_HUB_RUNNER_TRANSPORT_HOST` (one listener = one bind host). This
  also closed a latent exposure: the old runner listener bound `0.0.0.0` even on a
  local hub; now it follows `SLAYZONE_HUB_HOST` (loopback in local mode).

Not touched (out of scope): DB key `settings.server_port` (internal discovery
channel, renaming = a migration); plan-doc-only `SLAYZONE_PORT`/`SLAYZONE_HOST`
(aspirational, no live code).
