# Instant Cmd+Shift+N — typeable agent in ≤50ms

Status: PLAN (not approved). Owner task: 343a88b5.

## Goal

From Cmd+Shift+N keydown to a focused terminal whose keystrokes reach a live agent:
**≤50ms** (p50) whenever the project has a warm agent. Without one: no worse than today,
and keystrokes typed early are never lost.

## Where the time goes today (measured 2026-10-25, after e1bde6d58)

| step | cost |
|---|---|
| keydown → main menu accelerator → hub menu event → renderer WS subscription | unmeasured |
| `task.create` round trip | ~10–50ms |
| renderer: task tab render → Terminal mount (`preInit.openToMountMs`) | **500–740ms** |
| terminal init → `pty.create` → warm adopt | ~100–170ms |
| first agent frame painted | ~50–100ms |

Serial chain. Shaving each link cannot reach 50ms — the work must move BEFORE the keypress.

## Design: a pre-mounted spare

The warm pool already pre-boots the agent with the id its task will get. Extend "pre-made"
to the UI and the PTY registration, so the keypress only reveals and focuses.

### 1. Hub: adopt the warm agent into a spare session early

- New `pty.prepareSpare({ projectId })` → `{ taskId } | null`. Reserves the project's ready
  warm agent (same match rules as `reserveWarmTaskId`) for **this window's spare**, and
  registers it in the hub's `sessions` map under `${taskId}:${taskId}` right away (the
  existing computer rekey, `pty.warmAdopt`). `projectId`/`computerId` come from the
  reservation, not a task-row lookup — no row exists yet.
- From then on the session is an ordinary PTY: `pty.attach`, data subscription, `pty.write`
  all work by session id. Hooks already tolerate an agent whose task row does not exist yet
  (warm agents boot that way today).
- Spare lifetime: one per (window, project) for every project with open tabs — same gate
  as the warm pool (`setProjectTabCounts`). Killed when the window closes, the project's
  open-tab count drops to 0, the spare's agent dies, or on shutdown. No TTL kill while the window holds it (it is visible-on-demand, not orphaned) —
  billable-idle cost is the same one warm agent the pool already keeps.
- Pool re-arms after a spare is taken (as `reserveWarmTaskId` does today), so the NEXT
  press also has a warm agent ready.

### 2. Renderer: keep the spare tab mounted, hidden

- When a spare exists, mount a lightweight **SpareTerminalPane**: only the Terminal for
  `${taskId}:${taskId}`, inside `<Activity hidden>`/offscreen, sized to the task-terminal
  geometry. Not TaskDetail — that issues ~30 task-scoped queries that would 404 before the
  row exists, and is the 500–700ms cost we are removing.
- xterm is created, attached, WebGL parked (existing `webgl-budget` hidden-terminal rules).

### 3. Keypress: reveal first, persist after

- Handle Cmd+Shift+N **in the renderer** keydown (shortcut registry, `new-temp-task`), keep the
  menu accelerator as fallback for when the renderer is not focused. Dedupe so one press =
  one task.
- On press with a spare:
  1. synchronously: open a task tab for `taskId` with an optimistic Task object
     (`Terminal N`, temporary), show the spare pane in it, `terminal.focus()`.
  2. async: `task.create({ id: taskId, isTemporary, … })` with a caller-supplied id (new
     input field, validated: must equal a spare this window holds).
  3. when the row lands, TaskDetail mounts around the terminal; the Terminal remounts via
     the existing **cached-xterm reattach** path (`terminal-cache.ts`), so no re-init, no
     flash, typing uninterrupted.
  4. `pty.prepareSpare` again for the next one.
- On press without a spare: today's path, plus keystroke buffering — xterm opens at once and
  input is queued until `pty.create` resolves (no lost keys).

### 4. Fix the 500–700ms tab render anyway

Every task open pays it, not just Cmd+Shift+N. Renderer CPU profile of one press
(2026-10-25, 51 open tabs, 2,413 tasks), main thread from the press:

| ms | what |
|---|---|
| 0–100 | idle — waiting on menu event + `task.create` round trip |
| 100–550 | React render of the new task tab (~200ms), full `task.loadBoardData` refetch decoded (~35ms superjson) — triggered by the create's tasks-changed notify — then a 50ms GC pause |
| 550–1200+ | React re-renders interleaved with `replaceEqualDeep` (~113ms total, still running at +1.2s) |

`replaceEqualDeep` is react-query structural sharing, almost all of it under
`TaskMetadataSidebar` → `useQuery(task.loadBoardData, { select: board => board.tasks })`
(`packages/domains/task/src/client/TaskMetadataSidebar.tsx:44`): every board refetch
deep-compares the whole 2,413-task array per observer. Fixes to evaluate:

- 4a. Creating one task must not refetch + re-decode the entire board: patch the board
  cache with the created row (the handlers already do `data.setTasks`) and skip the
  notify-driven refetch for the originating window, or make the refetch incremental.
- 4b. Blocker picker should not subscribe to the full board at mount: load the task list
  lazily when the picker opens (or a lean `{id,title,status,project_id}` query).
- 4c. Re-measure; then profile React's own ~200ms tab render with `SLAYZONE_PROFILE=1`.

## Measurement

- `renderer.timeline.instant_temp_task`: keydown ts → tab visible → xterm focused → first
  keystroke written to PTY. One event per press. Gate: p50 ≤50ms on the dev app.
- e2e: press Cmd+Shift+N with a warm spare, type immediately, assert bytes reach the PTY and
  the task row exists afterwards; press twice fast (second has no spare → cold path, no lost
  keys); close window with spare → agent killed.

## Risks

- Hub sessions map holding a session whose task row does not exist: audit consumers that
  look up the task by session (state machine, attention, idle-close, hibernation, CLI
  `slay` resolution) — each must tolerate a missing row until create lands.
- `task.create` with caller id: must reject ids not backed by this window's spare.
- Multi-window: spare is per window; a second window does not steal the first's spare.

## Decisions (2026-10-25)

1. Spare per project with open tabs — same gate as the warm pool.
2. 2 idle agents per project (spare + re-armed warm) is accepted.
3. Renderer handles Cmd+Shift+N keydown; menu accelerator stays as fallback.

## Progress (2026-10-25)

Done (renderer + hub, uncommitted unless noted):

- e1bde6d58 (committed): warm adoption skips the ledger resolver (−300ms); new temp task skips
  `pty.attach`; open-trace (`preInit` in `terminal.mount_timeline`).
- 4a: `task.create` announces a scoped change; `task.loadBoardRows` returns `nextTaskIds` (board
  successor via `LEAD() OVER (TASK_ORDER_BY)`), `patchBoardRows`/`patchMirrorTasks` place new and
  moved rows → no whole-board reload per create.
- 4b: blocker picker reads the board only while its dialog is open (`BlockerPicker`).
- Renderer keydown for `new-temp-task` (menu accelerator kept; `trigger-dedupe.ts` pairs the two).
- `TerminalStarter`: temp + known-unspawned session starts without `pty.exists`/settings round trip;
  a pending explicit start mounts the terminal on first render.
- Terminal-first: `markTerminalFirst` → `TaskPaneFallback`/`TerminalFirstShell` mounts the main
  terminal (props from shared `mainTerminalProps`, cwd `plainMainTerminalCwd`) before the task page;
  page waits for the agent (`TERMINAL_FIRST_HOLD_MAX_MS` cap), then reattaches the cached xterm.
- No lost keys: `input-gate.ts` holds input until the PTY exists; `early-input.ts` captures keys
  between the press and the new xterm (previous terminal blurred, focus self-heal stands down).

Measured (dev app, CDP press): key → `task.create` sent ~2–60ms; terminal visible ~80–200ms;
keys typed from 30ms after the press land in the new agent (verified `❯ hi`); agent screen
~350–500ms (main thread shared with the page render under load).

Remaining: hub spare (sections 1–3: pre-adopted, pre-mounted agent) for ≤50ms echo; needs the
session-without-task-row decisions (access `resolveSession`, deferred `bindSessionToTask`).
