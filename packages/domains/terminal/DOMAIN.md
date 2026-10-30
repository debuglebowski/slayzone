# Terminal Domain

Manages PTY sessions for task execution. Supports multiple terminal modes (Claude Code, Codex, plain shell).

## Architecture

### Data Flow

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
type TerminalMode = 'claude-code' | 'codex' | 'terminal'
type TerminalState = 'starting' | 'running' | 'idle' | 'error' | 'dead'
type CodeMode = 'normal' | 'plan' | 'accept-edits' | 'bypass'

interface BufferChunk { seq: number; data: string }
interface BufferSinceResult { chunks: BufferChunk[]; currentSeq: number }
```

## Main Process (main/)

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
- `./chat-prompts` - prompt model of the timeline (`chat-prompts.ts`)
- `./terminal-themes` - terminal colour themes
- `./suppress-device-status` - xterm parser hooks that stop device-status / XTVERSION replies

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

### 2026-10 Session size readable (`attach.size`, `pty.onResize`)

The hub keeps each pty session's terminal size (spawn size, then every successful `resizePty`, clamped as the pty got it): `getPtySize`, `pty.attach` → `size`, and the `resize` event → `pty.onResize`. Read-only: nothing changes how a session is sized. It exists for a client that shows a session WITHOUT sizing it — the phone renders at the size the desktop set, scaled to its screen, because two clients resizing one terminal fight (each SIGWINCH re-lays out the agent's TUI for the other).

