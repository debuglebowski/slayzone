# Agent startup mode: one setting replaces "Auto-start" + "Pre-warm"

## Goal

One hub setting, `terminal_agent_startup` = `manual` | `auto` | `instant`, decides whether a
task's main agent starts when the task opens. It replaces the two independent checkboxes
`terminal_auto_start` and `terminal_prewarm_enabled`. Today those can be set to a combination
that doesn't make sense: pre-warm on + auto-start off boots agents nothing uses.

## Behaviour (agreed)

How the agent last ended → what opening the task does:

| Mode | Running when app closed | Auto-stopped (idle timeout) | Stopped (by you, crash, `/exit`) | New task, never started |
|---|---|---|---|---|
| `manual` | Start button | Reopen button | Start button | Start button |
| `auto` (default) | Starts (resumes) | Reopen button | Start button | Starts |
| `instant` | Starts (resumes) | Starts (resumes) | Starts | Starts |

- Pre-booted agent (warm pool) runs in `auto` + `instant`, not `manual`. A new task takes one
  if one fits. Otherwise it starts a new agent normally, which takes a few seconds longer.
- Temporary tasks always start (unchanged).
- Agents in non-main tabs and plain-terminal tabs always start (unchanged).
- Tasks that exist before the migration count as "stopped".
- On boot, tasks whose agent was running reopen in the background (`listAutoRestoreTaskIds`).
  This happens in `auto` + `instant` only; `manual` restores nothing.

## Current state (findings)

- `terminal_tabs` already records how the agent ended, as two flags:
  `was_spawned` (1 = running; cleared on exit, kept on app shutdown) and `hibernated`
  (1 = auto-stopped). (0,0) means stopped OR never started; nothing tells the two apart.
- **Bug: `hibernated` is never written.** `setHibernatedTabRecorder` is only re-exported from
  `terminal/src/electron/index.ts` and nothing calls it; `apps/hub/src/tab-flag-recorders.ts`
  wires only the spawned recorder. This is the same "lost when pty moved to the sidecar"
  orphaning as the idle-close config, the warm pool and `was_spawned`. Effect: after a reload,
  an auto-stopped agent looks like a plain stopped one (no Reopen copy, no 💤 dot).
- **Bug: wrong scope.** `terminal_auto_start` is read by hub code (`task/server/ops/create.ts`)
  but isn't in `HUB_KEYS` (`settings/server/scope.ts`). On a hub that requires login it
  would be stored per user, and the hub would never see it.
- Decision points that each read the settings themselves today:
  `TerminalStarter.tsx` (Start gate), `useChatLifecycle.ts` (chat auto-start), `create.ts`
  (warm reserve), `composition.ts` (pool `isEnabled`), `useTabStore.restoreActiveSessionTabs`
  (boot restore).
- The main tab row is created lazily on first open (`ensureMainTab`), so a pre-existing task
  often has no row at all.

## Design

### 1. One enum column instead of two flags

Migration (next free version): add `terminal_tabs.agent_state TEXT NOT NULL DEFAULT 'stopped'`
with values `new` | `running` | `auto_stopped` | `stopped`. Backfill:
`was_spawned=1 → running`, `hibernated=1 → auto_stopped`, everything else → `stopped`.
Then drop `was_spawned` and `hibernated` (same migration), so the two can never drift.

- `markTabSpawned` / `markTabHibernated` → one `setTabAgentState(db, tabId, state)`.
- Recorder seams in `pty-manager` / `chat-transport-manager`: spawn → `running`,
  exit → `stopped` (except during app shutdown, unchanged), hibernate → `auto_stopped`.
  The hibernate kill's exit must not overwrite `auto_stopped` with `stopped`; order it the
  same way the shutdown gate works.
- `wireTabFlagRecorders` installs all of them in the hub. This fixes the orphaned
  `hibernated` bug, with a test that fails first.
- `TerminalTab.wasSpawned` + `.hibernated` → `agentState`, everywhere they are read: tabs-store,
  routers, window-api shim, `listAutoRestoreTaskIds`, `listHibernatedSessionIds`, pty-enricher,
  `_start-main.ts`, `TerminalSplitGroup`, `ChatPanel`, e2e helpers.

"New task" = task create writes the main tab row with `agent_state='new'` up front (done in the
transport-layer create path, so the `task` domain doesn't import `task-terminals`). Rows created
lazily by `ensureMainTab` default to `stopped`, which gives "pre-existing tasks count as stopped"
for free.

### 2. One decision function, shared by every caller

`terminal/src/shared/auto-start.ts`:

```ts
export type AgentStartupMode = 'manual' | 'auto' | 'instant'
export type AgentState = 'new' | 'running' | 'auto_stopped' | 'stopped'
export const AGENT_STARTUP_SETTING = 'terminal_agent_startup'
export function parseAgentStartupMode(raw: string | null | undefined): AgentStartupMode // default 'auto'
export function agentStartsOnOpen(i: { mode; state; isTemporary }): boolean
export function warmPoolEnabled(mode): boolean          // auto | instant
export function restoresOnBoot(mode): boolean            // auto | instant
```

Callers:
- `TerminalStarter` (replaces the `wasSpawned`/`hibernated`/`agentAutoStarts` branches; keeps
  `markForceStart`, the live-PTY reattach and the hydration gate). If the answer is "don't
  start", it shows the Reopen screen for `auto_stopped`, otherwise the Start screen.
- `useChatLifecycle` (same rule for chat).
- `create.ts` warm reserve (`state='new'`).
- Hub pool `isEnabled`. Read through the shared `SettingsService` cache, like idle-close does,
  which also removes the hand-rolled `refreshPrewarm` query.
- `restoreActiveSessionTabs` / `listAutoRestoreTaskIds`.

### 3. Setting + migration of old keys

- `terminal_agent_startup` goes in `HUB_KEYS` and in the `settings-admin` allowlist.
  `terminal_auto_start` and `terminal_prewarm_enabled` are removed from both.
- Same DB migration: `auto_start=1 & prewarm=1 → instant`, `auto_start=1 → auto`,
  any existing install otherwise (`auto_start` 0 or unset, at least 1 task present) → `manual`.
  A fresh install writes nothing, so it gets the default `auto`. Then delete the two old rows.
- Settings UI (`TerminalPanelSettings`): the two switches become one Select with 3 options,
  each with a one-line description. `usePanelSettings` follows.
- Start-gate checkbox "Don't show this again": in `manual` it sets `auto`; in `auto` it sets
  `instant`. The hibernated-screen checkbox ("Don't auto-close this agent") is unchanged.

## Tests (TDD: write each one and watch it fail before changing code)

- Unit: `agentStartsOnOpen` for the full mode × state × temporary matrix (= the table above).
- Unit: migration backfill of `agent_state` + settings mapping (fresh vs existing install).
- Unit: `tab-flag-recorders.test.ts` asserts hibernate writes `auto_stopped` (fails today).
- Unit: pty-manager: a hibernate kill ends as `auto_stopped`, not `stopped`.
- Unit: `create-warm-reserve.test.ts` re-keyed to the new setting.
- E2E: update `59-warm-pool-computer`, `30-terminal-core-behavior`, `55-crash-recovery`,
  `94-session-invalidation` to the new setting; add one spec walking the table
  (auto: stopped task → Start button, new task → starts; instant: stopped task → starts;
  manual: running-at-quit → Start button after restart).
- `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, affected e2e groups.

## Order

1. Shared decision function + tests.
2. DB migration (`agent_state` + settings) + tests.
3. Recorder rewire (fixes hibernated) + tests.
4. Swap every reader to `agentState` / the new setting.
5. Settings UI + Start-gate checkbox.
6. E2E updates + new spec. Full verification.

## Unresolved questions

None.
