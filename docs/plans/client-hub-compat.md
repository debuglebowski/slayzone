# Client ↔ hub version compatibility

## Problem
A remote hub and the clients that connect to it (desktop, web-shell, mobile, CLI) update independently, so they can be on different releases. Nothing checks for this. A client on a different release than its hub hits `NOT_FOUND` errors, silently dropped input fields, or renderer `TypeError`s. Hub ↔ computer is already solved (`COMPUTER_PROTOCOL_VERSION` + auto-upgrade), so it is not in scope.

## Model
- `HUB_API_VERSION`: an integer, bumped only when the API changes in a breaking way. It is separate from the release semver.
- The hub declares `minClientApi`. Each client declares `minHubApi`. A connection works when both sides are within the other's minimum. That range is the **support window**.
- Within the window: everything works, and a new feature hides itself on a hub that lacks it.
- Outside the window: a clear message for that hub only, and no calls are made to it.

## Phases

### 1. Handshake
- `hub.describe` gains `api: { version, minClient }` and `features: string[]`. It already has `version`.
- Freeze `hub.describe` as the forever-stable contract, and add a test that fails if its shape changes.
- Clients send `apiVersion` in `connectionParams` (desktop and web: `transport/src/client/runtime.ts`), and the REST API (CLI) sends it in a header.
- The hub rejects a client below `minClientApi` with a typed `CLIENT_TOO_OLD` error.
- The client reads `describe` before anything else. Below `minHubApi`, it marks that hub `incompatible`.

### 2. UI
- Each hub shows its state in the hub card and the sidebar:
  - "Hub v0.40 — needs update to work with this app"
  - "This app is too old for hub X — update"
- Calls to an incompatible hub are blocked at the link layer (as `connectDeadlineLink` does now), so no crashes.
- The hub card shows the hub's version, plus "update available" for admins.

### 3. Feature gating
- The `wire` flags (`compactBytes`, `toolPreviews`, `chatDisplay`) fold into `features`; keep the old fields until they leave the window.
- Add a helper `hubHas(client, 'feature')` (generalizing `hubCapabilities.ts`). UI for a new feature checks it.
- Rule: a new input field whose silent loss matters must be feature-gated, because zod strips unknown keys on an old hub.

### 4. CI contract check
- A script uses the TS compiler API to walk `AppRouter` and emit `api-snapshot.d.ts`: `{ '<path>': { input; output } }` for every procedure. Outputs come from inferred TS types, not zod: only 27 of 1353 procedures declare `.output()`.
- Commit the snapshot each release under `api-snapshots/<HUB_API_VERSION>.d.ts`.
- A compat test checks assignability in both directions against every snapshot still in the window:
  - Old client → new hub: old input assignable to new input; new output assignable to old output.
  - New client → old hub: the reverse, unless the procedure is behind a feature in the old snapshot.
- On failure: either make the change additive, or bump `HUB_API_VERSION` and accept the narrower window.
- Runs in `pnpm lint`.

### 5. Cross-release smoke (later)
- In CI, build the hub from the previous release tag and run a small client smoke test against it: connect, list projects and tasks, open a task, chat start/stop.

### 6. Process
- Expand/contract: rename = add new → migrate clients → remove old only once it has left the window.
- Document this in `ARCHITECTURE.md` and the release skill, and have the release skill print the current window.

## Out of scope
- Hub auto-upgrade (separate decision).
- Hub ↔ computer (already solved).

## Unresolved questions
1. Window length: N-2 releases? 30 days?
2. Mobile: longer window?
3. Hub inputs: `.strict()` (reject unknown keys loudly) or keep stripping + feature-gate?
4. CLI REST in scope now or later?
5. Phase 5 now or later?
