# Terminal Domain

Manages PTY sessions for task execution. Supports multiple agents (Claude Code, Codex, plain shell).

## Architecture

### Task completion and agent lifecycle

A done task keeps no agent: reaching a terminal task status stops every agent of
the task — PTYs, hub chats and computer-owned chats — even mid-turn. The desktop
(⌘⇧D, board moves) completes immediately. The CLI (`slay tasks done`,
`slay tasks update --status <terminal>`) refuses while any of the task's agents
is mid-reply (state `running`), its own included, unless `--force`. Messages sent
during a turn queue until it ends; only explicit steering adds them to the running
turn.

### Agent exits: resume, recovery shell, or end

When a terminal agent's process exits, `decideUnexpectedExit`
(`pty-exit-strategy.ts`) decides. An agent that died MID-SESSION without anyone
asking — non-zero code or a signal, ≥10 s after its first output, no `killPty` /
hibernation / quit on record, no transport reason (`exited-while-detached`, …), no
exit 130 or ^C/^D typed ≤10 s before — is resumed on its current conversation, in
place: the same session continues (`createPty` continuation: scrollback and seq
carry over, an info line marks the restart, the terminal sees no exit), and
`pty.auto_resumed` is recorded. At that moment the tab shows `starting` and the
info line, the dead process's agent tree is dropped (`replacing`), and input typed
before the new process exists is held for it (never typed into a recovery shell).
A resume its computer refuses to start falls back to the recovery shell. Only providers with a `resumeCommand` that resumes
faithfully (the hibernation set) and a known conversation id. At most once per
session per 5 min; a second death in that window gets the recovery shell plus
`pty.auto_resume_rate_limited`. Everything else is unchanged: a start failure gets
the interactive recovery shell, a stale resume its overlay, a requested kill ends.
Regression: 2026-11-14, the hub's stray sweep SIGHUP'd 31 live agents (exit 129).

An exit SlayZone asked for (`exitWasRequested`: `killPty` — close, replace, task
done, hand-off — app quit, hibernation) always just ends the session: no recovery
shell, no fast-exit retry, no resume, whatever the code. The code alone cannot tell:
a computer-routed kill reports a null code, mapped to 1. A recovery shell still in
flight when the kill comes is dropped (`decideRecoveryAdoption`). Recorded as
`pty.exit_requested` when the code alone would have given a recovery shell.

### Hub restart: adopt, else surface

Hub processes restart (Restart local hub, a crashed sidecar, a standalone hub, a
desktop restart with a remote computer); computers keep their ptys. A restarted hub
never starts a second process for a tab whose agent still runs, and never kills it
on no evidence:

- **Adopt.** Every reconnect list hands the routing backend the sessions nothing in
  this hub run tracks (`PtyBackend.untrackedSessions`). `unattached-sessions.ts`
  resolves each `<taskId>:<tabId>` into its tab's launch (task domain
  `resolveTerminalTabLaunch`, plain shell tabs included) and calls `pty.create`
  with `attach`: nothing is launched; the computer hands the running process to a
  new attempt (`pty.adopt`) and it is registered like any session (output, input,
  state, exit, auto-resume). A tab's own start of such an id does the same through
  `pty.spawn` `adoptLive` (the first spawn of an id in a hub run). Both record
  `pty.orphan_adopted`.
- **Ownership handoff.** A routed reattach returns a provisional lease. Its abort
  lifetime continues after the RPC succeeds until the manager atomically commits
  its registration. Abandonment releases only that routing generation and stops
  its exact attempt, or surfaces it when cleanup cannot be confirmed. Failed
  delivery/registration releases ownership too; newer registrations are untouched.
  The registry retains queued/active adoption identities through this handoff,
  independently of visible rows. Confirmed task disposal cancels all its identities
  and ends already-committed manager sessions. No permanent deletion tombstone set.
- **Surface.** What cannot be adopted (not a task tab, no detection or an older
  computer, the task elsewhere, another agent in the tab now, the computer refused)
  stays running and is listed with its reason (`pty.orphan_unattached`) — attach
  again or stop it (`pty.orphan_killed`). A tab start in another mode replaces it
  (`computer.orphan_replaced`).
- **Restart/reset.** A tab stop records replacement intent for its next successful
  start, even before the first session list or while its computer is offline.
  That spawn omits `adoptLive`, including reconnect resends; proactive adoption
  cannot consume the intent. The not-attached overlay Restart uses this same stop.
  Whole best-effort cleanup has one 5 s deadline across adoption, launch resolution,
  serialized preparation, all computers, kill and verification. Cancellation fences
  late adoption replies without killing a newer attempt. A failed cleanup records
  `pty.orphan_kill_failed` and returns false so reset, restart and tab close can finish.
  Confirmed task/tab deletion or ops disposal removes replacement intents; a kill
  after deletion checks the hub rows. Valid offline-tab intents have no expiry.
  Content erasure publishes database-scoped task notifications after commit for
  every scope (including project and user erasure); failed deletes retain intent.

### Codex silence and cancellation provenance

The running watchdog checks Codex with a bounded `thread/read` before treating
silence as a stall. A responsive app-server keeps its turn and conversation;
quiet reasoning is not evidence of failure. A failed health check retains the
existing kill/restart policy. Completion, Stop, and process replacement supersede
an outstanding probe. The check neither resumes a thread nor sends input.

Watchdog exits persist their cause; UI and ordinary CLI transcripts distinguish
them from requested Stops and unspecified interruptions. An OS exit code or a
Codex `turn_aborted` event alone does not establish that a user clicked Stop.

Audit task `9f22908f` reproduced the silence timeout on 2026-11-08 at
21:26:16, 23:02:22, 23:16:44, and 23:29:25 UTC. Computer event-log `watchdog-killed`
notices immediately preceded process exits and matching Codex rollout aborts.
Each followed five minutes without visible progress. The first two restarted
thread `01a1bd01-33ae-7ee2-8367-7259ad643b27`; the later kills had exhausted the restart
budget. This occurred before task completion, separately from the completion
lifecycle bug fixed for task `e06a3842`. The logs establish watchdog cancellation,
not whether inference was still progressing during those silent periods.

### Chat lifecycle migration

`shared/chat-lifecycle.ts` is a pure, versioned lifecycle model. Inputs identify
the tab, process generation, revision, and main/child actor; attributed ends also
identify their turn. Main work, pending prompts, background helpers/jobs and
outbox admission remain independent. The existing outbox owns delivery; the model
does not infer acknowledgement from a spinner or transcript counter.

The computer's transport observes this model in `ChatLifecycleShadow`; production
state, queueing, prompts, Stop, and UI still use the existing runtime. A session's
`CreateChatOpts.lifecycleMode` is chosen at hydration (`shadow` by default;
`legacy` disables observation). Comparisons run after synchronous operations
settle. Diagnostics keep only counts/flags and field names, capped at eight
distinct reports per process. Observer or diagnostics failure never controls chat.
Unchanged token fragments cause no extra comparison.

`AgentEvent.execution` carries a process-local execution identity and its source:
`provider` for Codex's native turn IDs, `ordered` for Claude's serial stream. An
optional `messageId` links that execution to its original outbox request; steering
joins it without replacing the identity. `turn-started` is an internal binding
event, not a timeline row. Stream snapshots and synthesized saved blocks retain
their captured ownership. Older histories without ownership remain readable.

Codex captures identity at notification/request dispatch, including delayed
approval answers and stream closure. Recognized older starts, completions, text,
and failed start replies cannot settle or replace a newer execution. The transport also
fences attributed old root events before outbox, prompt, stream or lifecycle
changes. Helpers and background commands retain their owner across root turns.
Delivery acknowledgements keep their own message IDs and remain independent.
Native IDs can precede their host correlation. A fast completion with neither a
known active ID nor a correlated host ID retains the existing ordered fallback;
that unproven association also remains a cutover gate.

Claude assigns ordered IDs from the host request (or a fresh autonomous ID),
retains live helper/job ancestry, and deduplicates result UUIDs and optional
process-local result indices. Recent UUIDs and ended jobs are capped at 256;
active work is retained. This is inferred attribution: an unseen late result with
no native request identity, known UUID, or usable ordered index cannot be proven
to belong to an older request. That protocol limitation remains a cutover gate.

Authoritative cutover still requires migration of all status consumers together.
Known disagreement:
legacy approval resolution can reopen an idle parent after a background-only
prompt; the candidate preserves its idle main turn and reports the difference.

`pnpm test:chat:lifecycle` runs the shared contracts, generated/exhaustive orderings,
provider races, live/replay parity, observer failure/privacy/bounds, and renderer
reconnect/dedup checks. Tests never use the caller's live app or provider account.

### Workspace changes in chat

Chat keeps exact native file-tool edits separate from saved net workspace changes.
Before sending a turn, the computer takes an isolated-index Git baseline; after
completion or interruption it captures the final tree. Saved diffs live in the hub
and survive commits, reloads, and computer disconnection. The next turn waits for
capture completion. Shared-workspace changes are observations, not authorship claims.
Non-Git workspaces and failed captures show unavailable; oversized text diffs show
partial. Capture helpers are exposed by `@slayzone/agent-turns/workspace-capture`.

### Chat side threads

`chat.threads` persists answer discussions in `chat_threads` (migration 180).
`threadForkSource` resolves a completed answer's provider fork point without
interrupting its parent, including history outside the in-memory event cache.
The child resumes its own conversation ID; it never writes the main task's
`provider_config` conversation ID. An unconfirmed child forks from its saved
source on start; a refused fork fails the child instead of resuming its parent.
Child events, drafts, queue entries, and processes use the ordinary chat runtime.
Returned conclusions bind queue entries to their source conversation (migration
181); draining rechecks this scope after popping and preserves a mismatched entry.

### Chat pinned messages

`chat.pinnedMessages` (`list` / `pin` / `unpin` / `onChanged`) keeps the rows a user
pinned, as `pinned-message` records of the tab's computer-side conversation, keyed by
provider conversation + row key. Content, not hub metadata: no migration, no
`task_state_versions` bump (local-only kinds; the record triggers are recreated on every
open), moved with the conversation, purged by retention. `pinMessage` refuses a pin for a
conversation other than the one hydrated (the view is behind a Reset / switch). Agent
tokens may list them, never change them.

### Chat history reads are bounded pages

No read answers or parses a whole conversation at once (chats reach hundreds of
MB). `ChatEventLog.readPage` returns one page — at most
`CHAT_HISTORY_PAGE_MAX_BYTES` (4 MiB) / `_EVENTS` (2,000), one event always fits —
reading stored sizes from record headers (`octet_length`) before loading only that
page's rows; `pages()` yields to the event loop between pages. Hydrate seeds the
cache from the store's tail and folds what it needs from the whole history
(outbox restore, fork re-arm, unfinished turn) in one paged pass; the projection
opens from its checkpoint and reads only the events after it. Clients and the hub
read `getEventPage` / `getReplayPage` (tRPC: `getBufferSince` / `getReplay` with
`page`); whole reads stay for older callers, assembled from pages. Hub routes read
the reduced history through `@slayzone/terminal/chat-history` (projection snapshot,
older rows on demand). `timelinePages` answers within the same byte budget and
names what it left out (`omitted`). Asked from a row (`startRow`, what every current
client sends) the budget cuts between ROWS — one row always fits — so a 256-row page
larger than the budget (long tool output made one 6.6 MB) comes in slices: `next`
names the row to ask from. Without `startRow` (an older client) whole pages, as
before; a computer takes `startRow` only once it advertised `chatTimelineRowSlices`
(hello/enroll, additive) — the hub drops it for an older one. `openTimeline`'s events
after its snapshot are one history page at most: more, and it takes a fresh snapshot
(up to 3), else answers `full`.

Historical page reads restore undo values before sizing rows or whole pages, so
late results that shrink content cannot overfill an older snapshot's answer.
The worker forwards `startRow` with the captured sequence/epoch; continuations
retain the same historical view and leave live rows unchanged.

Heavy history work takes turns process-wide (`historyReadTurns`): a page read is
one `take`; a projection's rebuild folds (256 events a step), its page writes
(`TIMELINE_FLUSH_SLICE_BYTES`, 1 MiB of encoded rows a store write, one page always)
and a stored projection's drop (chat-runtime `dropTimelineInSteps`) are `job`s whose
steps each take a turn, with the event loop running between two steps even when
nothing else waits — but no turn before a job's first step or after its last, so a
lone open adds none before its agent spawns. A sliced flush drops the stored
checkpoint with its first slice and stores the new one only with its last: stopped
half way, the next open rebuilds. Measured (FU4, 60 chats × 2,000 events, real
computer store): most main-thread CPU in one loop iteration, rebuild 5.0 s → 50 ms,
restore 2.7 s → 28 ms, reset 4.1 s → 62 ms
(`chat-runtime/src/server/__perf__/timeline-restore.perf.test.ts`).

Computer storage now schedules its own bounded deletion/write/metadata turns. The
projection releases its encoding/checkpoint-read turn before awaiting these calls,
so compatibility stores sharing the scheduler cannot deadlock. Worker stores can
provide optional metadata callbacks; custom/older record stores keep a paced raw-page
fallback. Encoded page bodies and metadata are still produced on the projection's
thread; captured owner/epoch checks stay in the database owner for every step.

Saved-event publication awaits the actual insert. `ChatEventLog.append` returns a
Promise of the committed entry; only then does the ring/sequence advance. A failed
insert poisons the log and later flushes reject. Each tab orders provider events,
live fragments, host markers and their effects through one producer chain; a live
fragment cannot overtake an earlier pending save. Readers and lifecycle drains
wait for the accepted prefix, including generated delivery events/notices. User
dispatch commits its event/queue-handoff/prompt transaction before provider delivery.

Each process generation owns an anonymous async output spool. Storage pauses event
consumption; raw stdout keeps reading so Claude control responses and Codex RPC
responses reach their real pending requests. Pipes pause only while one chunk (or
one complete protocol record) spills, then resume independently of SQLite. Overflow
has no data cap or per-event promise backlog. The private file is unlinked before
content writes, reclaimed after drain, and physically closed before process exit
acknowledgement. File failure stops the process and rejects its drain.
A prepared public control inserts a causal boundary into that same output spool.
Pre-control events drain before the ordinary stop/pop decision; later records
spill while protocol ACKs remain live. The continuation reuses the real provider
result, fences workspace-delayed/outbox writes and queue drain, and releases the
boundary before normal provider withdrawal/rewind waits. It validates the exact
captured process generation; no replay can interrupt a later generation or user
turn. Physical kill/remove keep outbox writes fenced through normal cleanup.
A genuine close-only FileHandle failure retains generation/removal ownership and
can retry physical close after repair. Lost writes or durable event failures stay
fenced; hydrate/provider transition cannot pass an unresolved anonymous file.

Bidirectional drivers expose `handleControlLine`; custom stream-only drivers keep
the same interface. Autonomous notification/poll readers await `waitForOutput`
before producing another spill batch. Registered chat modes are Claude and Codex;
other providers/custom modes use the existing PTY adapters.

Imported history drains as one batch. Physical exit and stdio drain stay separate:
replacement/close retains pre-EOF tail, terminal EOF rejects later bridge bytes,
and the watchdog excludes deliberate storage pressure. Readers/lifecycle drains
include the accepted spooled prefix. Codex observes turn control boundaries
separately from delayed timeline processing, so interrupt-and-wait can acknowledge
real completion without publishing it early. The computer-local routing bridge
implements generation-scoped physical flow. Exported custom/legacy handles without
an input-flow seam retain compatibility but cannot promise a bounded upstream
producer. Current production chat runs on its owning computer; no new remote-raw
route is introduced.

### Chat side questions (`/btw`)

`chat.sideQuestion.ask` answers a question from the tab's conversation without
adding it, mid-turn too. Nothing is persisted: no DB row, event, or transcript
line. The answer lives in the renderer's side card until dismissed. Claude Code
uses its `side_question` control request (one tool-less query that skips the
transcript; `history` carries follow-ups; cancel = `control_cancel_request`).
Codex forks the thread ephemerally (`thread/fork {ephemeral, excludeTurns,
lastTurnId}` through the last finished turn), runs one read-only,
approval-free turn on the fork, then `thread/unsubscribe`s it. The driver routes
every notification of its forks away from the main timeline, late ones too.
Codex 0.166's `thread/sample` refuses a thread with a running turn, so the fork
is the one path. Live check: `agents/side-question.live.ts`.

### Codex background terminals

The chat driver polls Codex's native `thread/backgroundTerminals/list` registry
while its app-server process lives. Jobs feed the shared command-task timeline
and background-jobs banner; Stop targets the native process ID. Turn completion
preserves registered jobs. Missing jobs end after a successful complete listing;
transient errors preserve state, unsupported CLIs disable polling, disposal stops it.
Detached shell daemons outside Codex's registry are not tracked.

### Data Flow

Chat attachments stay as sealed artifact references through admission, queueing,
retry and history. Drivers read their bytes during outbox preparation: Claude
builds image/document blocks; Codex builds native image data URLs (images only).
Native payloads remain transient. `chat_attachment_messages` (migration 182)
keeps artifact references by task and client message ID across Reset and tab
closure; history import joins them back to Codex user items. The table contains
neither prompt text nor image bytes and is deleted with its task.

```
PTY Process (node-pty)
        ↓
   pty-manager.ts
        ├─ filterBufferData() - removes OSC/DA sequences
        ├─ RingBuffer (5MB) - stores {seq, data} chunks
        └─ IPC pty:data(taskId, data, seq)
             ↓
        PtyContext.tsx (global)
             ├─ Tracks lastSeq per task (ordering)
             └─ Notifies per-task subscribers
                  ↓
             Terminal.tsx
                  └─ xterm.js.write(data)
```

### Buffer Strategy

**Single source of truth: Backend RingBuffer**

- Backend holds 5MB ring buffer per PTY session
- Frontend tracks `lastSeq` for ordering, no data buffer
- On restore, fetch from backend via `getBufferSince(taskId, -1)`
- Sequence numbers ensure no data loss or duplication

### Sequence Number Protocol

1. Each PTY data chunk gets monotonic sequence number
2. Frontend tracks `lastSeq` per task
3. IPC `pty:data` includes seq - frontend drops if `seq <= lastSeq`
4. `getBufferSince(afterSeq)` returns only chunks with `seq > afterSeq`
5. Eliminates race conditions during tab switch/restore

### Terminal Cache

- xterm.js instances cached on unmount (not disposed)
- Reattached on remount for instant restore
- Mode change triggers dispose + fresh PTY

### Listener Lifecycle

- Global IPC listeners in PtyProvider survive all view changes
- Per-task subscriptions managed via Sets
- `cleanupTask(taskId)` frees all memory when task deleted

## Contracts (shared/)

```typescript
type AgentId = 'claude-code' | 'codex' | 'terminal'
type TerminalState = 'starting' | 'running' | 'idle' | 'error' | 'dead'
type CodeMode = 'normal' | 'plan' | 'accept-edits' | 'bypass'

interface BufferChunk { seq: number; data: string }
interface BufferSinceResult { chunks: BufferChunk[]; currentSeq: number }
```

## Main Process (main/)

`./pty-backend` exposes the PTY backend seam and cancellation wait helper without
loading the full server runtime, for computer-transport and hub consumers.

- `registerPtyHandlers(ipcMain, db)` - PTY lifecycle (create, write, resize, kill, getBufferSince)
- `PtyManager` - Session management, buffer caching, state detection
- `RingBuffer` - Sequenced ring buffer with ANSI-safe truncation
- Mode adapters for Claude Code, Codex, plain terminal

### Activity Detection (Claude Code)

The `ClaudeAdapter` detects `'working'` from spinner glyphs. When no spinner is detected
within `idleTimeoutMs`, the session transitions to `'idle'`.

| Pattern | State | Description |
|---------|-------|-------------|
| `·✻✽✶✳✢` at line start | running | Spinner animation (working) |

### State Transition Debouncing

- **`running`**: Immediate transition (work resumed, show it right away)
- **`idle`/`error`/`dead`**: 100ms debounce (coalesces rapid bursts)

## Client (client/)

- `PtyProvider` / `usePty()` - React context for terminal state and subscriptions
- `Terminal` - xterm.js component with sync restore from backend
- `terminal-cache` - Instance caching for fast tab switches
- `TerminalStatusPopover` - Session state indicator

DOM-free subpaths (the mobile app bundles them into React Native; `packages/apps/mobile/src/shared-logic.test.ts` imports them there):
- `./reducer` - chat timeline reducer (`chat-timeline.ts`)
- `./chat-lifecycle` - pure candidate lifecycle reducer and versioned snapshots (shadow migration)
- `./chat-prompts` - prompt model of the timeline (`chat-prompts.ts`)
- `./terminal-themes` - terminal colour themes
- `./suppress-device-status` - xterm parser hooks that stop device-status / XTVERSION replies
- `./terminal-state` - the terminal-state rules (`terminal-state-reducer.ts`): session state from the hub's pushes + `sessionList` snapshots; `useTerminalStateStore` applies them
- `./live-blocks` - `LiveBlockStore` / `useLiveBlock`: what streams into each chat row, outside React state (React only, no DOM)

## Safety Patterns

### IPC Send Safety
All `webContents.send()` calls are wrapped in try/catch to handle TOCTOU race where window can be destroyed between `isDestroyed()` check and send.

### Abort Signal Checks
All async operations in Terminal.tsx check `signal.aborted` before calling setState to prevent "setState on unmounted component" errors.

### State Lifecycle
- Global IPC listeners only update existing state, never create state for unknown tasks
- State is created when Terminal component subscribes (via `getOrCreateState`)
- `cleanupTask(taskId)` removes all state and subscriptions when PTY exits
- Cached terminals are disposed on PTY exit

### Timeout Management
- `statusWatchTimeout` cleared in `killPty()` to prevent orphaned callbacks
- `markSkipCache` tracks timeouts per taskId, clears previous before setting new

### Bounds Validation
- `resizePty()` clamps cols/rows to [1, 500] to prevent crashes

## Dependencies

None (foundational domain).

---

## Decision Log

### 2025-01 Terminal Stability Review

**Context:** Comprehensive code review identified 15 issues across backend, frontend, and cache layers.

**Issues Fixed (12):**

| # | Issue | Fix |
|---|-------|-----|
| 1 | statusWatchTimeout leak on kill | Clear timeout before session delete |
| 2 | getOrCreateState recreates deleted tasks | Only update existing state in global listeners |
| 3 | No PTY exit cleanup | Call disposeTerminal + cleanupTask on exit |
| 4 | Error state stuck forever | Clear error when valid activity detected |
| 5 | setState on unmounted component | Add signal.aborted checks before setState |
| 6 | Uncaught promise in initialPrompt | Add try/catch and abort check |
| 7 | Abort listener never removed | Unified cleanup function in waitForDimensions |
| 8 | TOCTOU race - window destroyed | Wrap all IPC sends in try/catch |
| 9 | Post-spawn command timing | Increased from 100ms to 250ms |
| 10 | markSkipCache unbounded timeouts | Track timeouts per taskId |
| 12 | Missing abort checks in init | Add checks before all setState calls |
| 15 | No resize bounds validation | Clamp cols/rows to [1, 500] |

**Issues Not Fixed (3):**

| # | Issue | Reason |
|---|-------|--------|
| 11 | Ring buffer size accounting | Analysis showed accounting is correct |
| 13 | getState returns 'starting' default | Mitigated by backend state sync on mount |
| 14 | Console.log in hot path | Logs only in error/create/kill paths, not hot |

**Decisions:**

1. **State creation policy:** Only create frontend state when Terminal component subscribes. Global IPC listeners ignore events for unknown tasks. This prevents memory leaks from orphaned PTY sessions.

2. **Error recovery:** Clear error state when valid activity is detected (non-'unknown' activity). Allows terminal to recover from transient errors.

3. **Post-spawn timing:** 250ms delay before sending post-spawn command. Conservative but reliable. TODO: Could improve with shell-specific ready detection.

4. **Cleanup on exit:** Automatic cleanup of cached terminal and context state when PTY exits. Previously required manual cleanup, leading to memory leaks.

### 2025-01 Terminal Data Silent Drop Fix

**Context:** Terminal input/output not visible until page reload.

**Root Cause:** `PtyContext.onData` dropped data when no state existed for taskId (line 90-91). The `subscribe` function was supposed to create state via `getOrCreateState` but didn't - it only created subscriber sets.

**Fix:** Added `getOrCreateState(taskId)` call at start of `subscribe()`. Now state exists before any PTY data arrives.

### 2025-01 Terminal Sync Loss After Inactivity

**Context:** Terminal stopped receiving updates after being inactive ~60s, but PTY still running (reload showed output).

**Root Cause:** Hibernation (idle handler) set `terminalRef.current = null` while component stayed mounted. Data subscription kept firing but wrote to null ref. Nothing triggered reinitialization when tab became visible again.

**Fix:** Removed hibernation logic from idle handler. Terminals now stay alive while idle.

**Tradeoff:** ~5-20MB more memory per idle terminal. Acceptable for reliability.

### 2025-01 Terminal Sync Loss After Tab Switch

**Context:** Terminal stopped receiving updates after tab switch, but PTY still running (reload showed output).

**Root Cause:** Tabs use CSS `hidden` (display:none), not unmounting. When tab hidden, `initTerminal` returned early due to 0 dimensions → `terminalRef.current` never set. When tab visible again, resize handler only called `fit()`, didn't reinitialize. Data arrived but wrote to null ref.

**Initial fix (insufficient):** Check `!initializedRef.current` to trigger reinit. Failed because it didn't check `terminalRef.current`.

**Second fix (made things worse):** Set `initializedRef.current = true` before calling `initTerminal` to prevent concurrent calls. But `initTerminal` checks that same flag at line 118 and returns early! Terminal never reinit.

**Final Fix:**
1. Guard resize handler against 0 dimensions
2. Check `!terminalRef.current && !initializedRef.current`
3. DO NOT manipulate flag in resize handler - let `initTerminal` manage it internally
4. `initTerminal` handles concurrency via line 131 re-check after async wait

**Why this works:** `initTerminal` sets flag at line 138 AFTER dimension checks pass. Concurrent calls are caught by the re-check. No external flag manipulation needed.

### 2025-01 Terminal Sync Loss on Activity Transition

**Context:** Terminal froze when Claude transitioned from "working" to "idle". Logs showed `terminalRef=false` after transition.

**Root Cause:** Inline `onReady` callback in `TaskDetailPage.tsx`:
```typescript
onReady={(api) => { terminalApiRef.current = api }}
```
This creates new function reference on every render. Since `onReady` is in `initTerminal`'s deps, parent re-render (triggered by activity state change) caused effect cascade: cleanup runs → `terminalRef = null` → re-init may fail → data drops.

**Fix:** Memoize `onReady` with `useCallback` and empty deps:
```typescript
const handleTerminalReady = useCallback((api) => {
  terminalApiRef.current = api
}, [])
```

**Lesson:** Always memoize callbacks passed to components with effect-based initialization.

### 2025-02 Terminal State Flicker Fix

**Context:** UI flickered between 'running' and 'attention' states during Claude output.

**Root Cause:** Two issues:
1. Pattern `[>❯]` matched both `❯` (Claude's prompt) and `>` (markdown blockquotes in output)
2. No debounce on state transitions - brief output gaps triggered instant state change

**Fix:**
1. Changed pattern to only match `❯` character (not `>`)
2. Added asymmetric debounce: immediate for 'running', 100ms delay for 'attention'

**Why asymmetric:** When work resumes (spinner detected), show it immediately. When work might be done (no spinner), wait 100ms to confirm it's not just an output gap.

### 2026-10 DOM-free subpaths for the mobile app

`./chat-prompts`, `./terminal-themes` and `./suppress-device-status` export the pure client modules as they are (no move): desktop keeps importing them through `./client` and relative paths, unchanged. The mobile app reaches them without the `./client` barrel, which loads xterm and React components.

### 2026-10 Terminal-state rules as plain reducers

`useTerminalStateStore`'s rules (hibernated swallowing the kill's `dead`, fill-only hydrate, the 4-pass reconcile with its dispatch-freshness guard, background-job counts) moved verbatim into `terminal-state-reducer.ts`: functions `(state, event, now) → patch`. The zustand store applies the patches with `set`; the mobile app's agent list runs the same functions over its per-hub state. One set of rules, no fork; the store's own suite still covers every rule through the store.

### 2026-10 Session size readable (`attach.size`, `pty.onResize`)

The hub keeps each pty session's terminal size (spawn size, then every successful `resizePty`, clamped as the pty got it): `getPtySize`, `pty.attach` → `size`, and the `resize` event → `pty.onResize`. Read-only: nothing changes how a session is sized. It exists for a client that shows a session WITHOUT sizing it — the phone renders at the size the desktop set, scaled to its screen, because two clients resizing one terminal fight (each SIGWINCH re-lays out the agent's TUI for the other).


### 2026-11 Bounded chat history reads

A whole-history `getBufferSince(-1)` (202 MB) closed the computer's hub socket
(1009) and stalled the computer (heartbeat timeouts), and every reconnect then
killed live agents. Every read that returns saved events or timeline rows is a
page with a cursor; whole reads remain only for older hubs and clients, built from
pages. Computers advertise `chatHistoryPages` (hello/enroll, additive); the hub
asks an older computer for its whole read and answers it as the last page.

Prepared controls for one captured generation share one causal stdout cut,
provider interrupt result and outbox fence. Distinct public commands each retain
their durable invocation/receipt and execute in order; kill/remove can escalate
that generation physically before storage unblocks. Physical exit resumes the
cut gate while preserving the marker's prefix capture, so process exit cannot
wait on its own output drain. The first durable stop uses that captured prefix;
later group decisions coalesce without interrupting or respawning a newer turn.
The outbox fence remains until all group owners settle. Abandoning a control
with unknown provider ACK retains the write fence until ACK/physical settlement;
a refused/timed-out ACK stops the captured process before that fence releases.
Physical ownership is still retained when actual exit cannot be confirmed.
