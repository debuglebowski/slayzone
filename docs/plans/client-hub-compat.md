# Client ↔ hub version compatibility

Status: implemented (phases 1–4, 6). Overview: ARCHITECTURE.md, "Client ↔ hub versions".

## Problem
A remote hub and its apps (desktop, web shell, mobile) update independently. Before this, nothing checked versions. A client on a different release than its hub hit `NOT_FOUND`, silently dropped input fields, or renderer `TypeError`s. Hub ↔ computer was already solved (`COMPUTER_PROTOCOL_VERSION` + auto-upgrade).

## Model
`packages/shared/trpc-server/src/api-version.ts`:
- `HUB_API_VERSION`: an integer, raised only when a minimum must exclude an older release.
- `MIN_CLIENT_API`: the oldest app a hub serves. `MIN_HUB_API`: the oldest hub an app works with. A side older than the contract counts as API 0.
- `HUB_FEATURES`: optional features. An app checks `hubHasFeature` before using one.

The first contract release sets `MIN_HUB_API = 1`. This app calls procedures a v0.43 hub lacks: open-tabs sync, batched git panel reads, clone-for-move. It also reads `sharing.taskSharing.projectId`, which a v0.43 hub never sends. So it says "update the hub" instead of breaking piecemeal. `MIN_CLIENT_API = 0`: v0.43 apps on this hub have 0 breaks.

## What was built
1. **Handshake.** `?clientApi=N` on every app socket (`createTrpcWsClient`). `hub.describe` gains `api: { version, minClient }` and `features`; a test guards its fields. The hub's `clientApiGate` (first in `publicProcedure`) refuses an older app with PRECONDITION_FAILED / `CLIENT_TOO_OLD`. In-process callers are exempt.
2. **UI.** A new `HubIssue` kind, `incompatible`, with `side: 'hub' | 'app'`, takes precedence over sign-in. It shows in the app-wide banner and in the Hubs card status ("Hub needs update" / "App too old for hub"). The card also shows the hub's release (`v0.44.0`). `hubCompatLink` sends an incompatible hub nothing but `hub.describe`, and rewrites a missing-procedure NOT_FOUND to "update the hub". Each socket reopen feeds a fresh `describe` into the shared cache, so an upgraded hub is seen without restarting the app.
3. **Features.** `hubHasFeature` reads `features`, falling back to the legacy `wire` flags. `compact-bytes` and `tool-previews` moved onto it.
4. **CI check.** `pnpm check:api-compat` (`scripts/check-api-compat.mjs`) compares HEAD with the newest stable `v*` tag:
   - The base is unpacked with `git archive` and installed (types only) under `node_modules/.cache/api-compat/<sha>`.
   - A generated file compares the two `AppRouter`s, procedure by procedure, through tsgo. Types are normalized to their wire shape first, so type-only brands don't count. tsgo has no compiler API, so the results are read from `noErrorTruncation` diagnostics.
   - Break categories: removed, added, input/output in each direction, and input fields silently dropped by an older hub's zod object (single object inputs only).
   - A break fails unless a minimum excludes that pairing or `packages/apps/api/api-compat.json` accepts it with a reason. `--explain` shows tsgo's reason; `--prune` drops stale acceptances.
   - Runs as its own CI job and in `release:tag`.
5. **Process.** Expand/contract: rename = add the new one → migrate clients → remove the old one once it is out of the window. Documented in ARCHITECTURE.md.

## Not done
- The CLI's REST routes (a separate Express surface, not tRPC).
- A cross-release runtime smoke test (an old hub build against the current client).
- Hub auto-upgrade.
