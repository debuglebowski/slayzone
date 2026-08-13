# Nest runners inside hubs (Connections settings)

## Decision

Replace the two sibling tables (Hubs, Runners) in the Connections tab with **one hub list, each hub owning its runners inline**.

A runner belongs to exactly ONE hub, fixed at token-mint time (the token embeds that hub's dial URL + TLS fingerprint) — see the header note in `RunnersSettingsTab.tsx:50`. Two flat tables represent that 1:N containment as a foreign-key column, which forces a hub picker into the enrollment flow and a `Hub` column into every row.

## What this buys

1. **Mint stops needing a picker.** `+ Add runner` lives inside a hub group, so position *is* the hub choice. Deletes `targetHubId` state, the `runner-add-hub` `<Select>`, and the class of error where a token is minted against the wrong hub.
2. **Mint becomes hub-correct by construction**, like revoke already is. Moving it into `RunnersHubRows` (inside `<HubScope>`) means an ordinary `useMutation` on that hub's client — no `getHubClient` lookup, no ambient-client fallback, no `revision` counter to cross-invalidate other hubs' caches.
3. **Deletes plumbing**: `showHubColumn`, `hubLabel` prop, the `Hub` column, `onCount`/`counts`/`total` union arithmetic, `revision`.
4. **Fixes the duplicated heading** — today `SettingsTabIntro title="Runners"` and the `<Label>Runners</Label>` both render (visible in the current UI).

## Current structure (what we're moving)

| | Source of truth | Reads |
|---|---|---|
| `HubsSettingsTab.tsx` (771 ln) | `electronBootstrap.getHubRegistry()` — the **draft boot-config**, editable, saved via `setBootSettings` | local row hardcoded + `remotes.map()` |
| `RunnersSettingsTab.tsx` (466 ln) | `useFederationOrNull()` — the **live** hub set, filtered to `!!h.url` | one `<RunnersHubRows>` per hub inside `<HubScope>` |
| `ConnectionsSettingsTab.tsx` (24 ln) | — | stacks the two with a divider |

**This mismatch is the one real integration hazard.** The hub list can contain rows the live federation does not have:
- a hub added but not yet saved (`dirty`, pre-relaunch),
- a hub whose URL is empty/unreachable,
- the local hub when `effectiveRunLocal` is false.

Those rows have no `HubScope` to query, so they must render a runner *placeholder*, never an empty runner list (an empty list reads as "no runners enrolled", which is a different and wrong claim).

## Target UI

One `<table data-testid="hubs-table">`. Per hub: the existing hub `<tr>`, immediately followed by a runners `<tr><td colSpan={4}>` holding an indented block:

```
Name          Address                      Default
─────────────────────────────────────────────────────────────
Local         this machine                  ●        [toggle] running ⟳
  Runners (1)
  local-runner   darwin-arm64  pty,git,fs,proc  ● Connected  Connected   ⟳ 🗑
  + Add runner
─────────────────────────────────────────────────────────────
Matrix        ws://127.0.0.1:51110/trpc     ○        Sign in ⚡ ✎ 🗑
  Runners (0)
  No runners enrolled.
  + Add runner
```

- **Group, not nested `<table>` with headers.** Runner columns (Platform / Capabilities / Status / Last seen) don't align with hub columns (Name / Address / Default), so the runner block gets its own inner table with its own light column labels. The outer `table-fixed` fractions keep hub rows aligned across groups regardless.
- **Always visible, not a disclosure.** Status is the column you scan; collapsing hides `Disconnected` behind a chevron. Per-hub runner counts are small.
- **Aggregate status on the hub row** — a dot summarising "N of M runners connected", so the cross-hub "what's down" scan survives the loss of the flat table.

## Implementation

### 1. `RunnerActionsProvider` (new — `RunnerActions.tsx`)

Owns the three dialogs that must exist once, not once per hub: minted-token, restart-local-runner confirm, revoke confirm. Plus the `restarting` flag and the `RECONNECT_SETTLE_MS` settle timer.

Context value: `{ requestRevoke, requestRestart, requestStart, showMintedToken, restarting }`.

Why a provider rather than props: the dialogs currently reach `RunnersHubRows` through six drilled props, and nesting adds a hub-table layer between them. Folding them into the 771-line `HubsSettingsTab` instead would be the wrong trade.

`electronBootstrap.restartLocalRunner()` stays exactly as-is (the runner is a child of the **main** process, not the hub — only the desktop bridge can cycle it; the fork's shim answers "not supported" → error toast).

### 2. `RunnersHubRows.tsx` — becomes `HubRunnersBlock`

- Renders its own `<table>` block (was: bare `<tr>`s into the shell's tbody).
- Drops `showHubColumn`, `hubLabel`, `onCount`, `revision`; keeps `hubId`, `isLocalHub`.
- Renders its own count line and empty state.
- **Gains mint**: `useMutation(trpc.computers.mintJoinToken.mutationOptions())` + inline label form + `+ Add runner`; on success calls `showMintedToken({token, hubLabel, hubUrl})` and invalidates its own `runners.list`.
- Keeps the local-runner specials verbatim: `DEFAULT_LOCAL_COMPUTER_NAME` restart button, and the `runner-local-missing` / `Start` row.
- Revoke keeps the closed-over thunk idiom — unchanged.

### 3. `HubsSettingsTab.tsx`

- After each hub `<tr>`, emit the runners `<tr>`.
- Resolve liveness: `const live = fed?.hubs.find(h => h.id === hubId && !!h.url)`.
  - live → `<HubScope hubId>{<HubRunnersBlock/>}</HubScope>`
  - draft-only / unsaved → "Save & relaunch to connect this hub, then enroll runners."
  - local hub with `effectiveRunLocal === false` → "Local hub is off."
  - `fed === null` (Chromium fork) → local group renders the block against the ambient client, mirroring today's `rowsFor(defaultHubId, '', true)` fallback.
- Wrap the table in `<RunnerActionsProvider>`.

### 4. `ConnectionsSettingsTab.tsx`

Becomes intro + `<HubsSettingsTab/>`. One merged `SettingsTabIntro` that teaches the containment:

> Where SlayZone's backend runs, and which machines execute its work. Each hub owns its own projects and tasks; runners are the machines a hub dials work out to. Pick a default hub for new projects, and enroll runners on the hub they should connect to.

`UserSettingsDialog.tsx:210` mapping (`connections` + `runner` tab ids → `ConnectionsSettingsTab`) is untouched.

### 5. `RunnersSettingsTab.tsx` — deleted

Every affordance it owns maps forward: mint → block, picker → group position, token dialog → provider, restart/start → provider, revoke → provider, counts → per-group, Hub column → group membership. Nothing is dropped.

## Test impact

TDD: run these first, watch them fail, then port.

- **`RunnersSettingsTab.test.tsx`** (543 ln) → split into `HubRunnersBlock.test.tsx` (mint, revoke, local-runner restart/start/missing — mocks `useTRPC` only) and additions to a `HubsSettingsTab` test for group resolution (live / unsaved / local-off / no-federation). Assertions to retire: `runner-hub-cell` (×3), `runner-add-hub` (×3), `runners-table` count.
- **`e2e/core/102-runner-settings-tab.spec.ts`** — keep testids `runner-add-open`, `runner-local-restart`, `runner-local-start`, `runner-local-restart-confirm` so this spec needs only a scoping change. `runner-add-open` is now per hub → scope it under a new `hub-group-${hubId}` container testid.
- **`e2e/computers/112-multi-hub-federation.spec.ts:635-652`** — rewrite: `runners-table` count-1 assertion and the `runner-add-hub` picker both go away; replace with "click `+ Add runner` inside hub B's group → `runner-minted-hub` names Hub B".

## Risks

- **Chromium fork** renders this dialog (15 tabs ported) with no `FederationProvider`. The `fed === null` branch must be covered by a unit test, not just reasoned about.
- **Draft/live divergence** is the correctness core. A hub row must never show an empty runner list when the real reason is "not connected yet".
- **`isAddOnly` live-add path** (`save()`) pushes new hubs into `useHubRegistryStore` without relaunch — so a group can go from placeholder to live mid-session. The liveness check must be reactive (it is: `useFederation` reads the store).

## Unresolved

1. Local group: keep the "Local runner / Not running / Start" placeholder row? (Recommend yes — only actionable empty state.)
2. Remote hub added-but-unsaved, or offline: placeholder text vs. hide the runner block entirely? (Recommend placeholder — hiding makes the hub look runner-less.)
3. Aggregate status dot on the hub row — in, or defer?
4. Keep `data-testid="runners-table"` on the per-group inner table (cheaper e2e port), or retire the id?
