# Session History sidebar

Add a **Session History** button beside the existing **Message History** button
in the agent terminal header. Only render it when the selected task has **more
than one agent session**. Clicking opens a new **Sessions** sidebar listing every
agent session tied to the task.

## Context (what exists today)

- The button the user calls "message history" is `AgentPromptsToggleButton`
  (icon `MessageSquareText`, aria-label `"Show messages sidebar"`) in
  `packages/domains/task-terminals/src/client/agent-prompts/AgentPromptsSidebar.tsx`.
  It mounts in the terminal tab-bar header: `TerminalContainer.tsx:485-489`
  (`rightContent`), gated by `canShowPrompts` (main group active + main mode is a
  `isPromptCaptureMode` terminal agent).
- Opens `AgentPromptsSidebar` (docks right, `TerminalContainer.tsx:511-513`): a
  flat transcript of every user prompt to the task's main agent.
- Open/close state persisted per-task in localStorage via `usePromptsSidebarOpen`.

## Data model — validated on live dev DB (2134 rows)

- Table `agent_sessions` (migration v147): one row **per spawn**. Columns:
  `id, mode, cwd, task_id, conversation_id, origin, status, created_at, bound_at`.
- **A "session" = a distinct `conversation_id`, NOT a raw row.** A `--resume`
  re-spawn writes a new row that reuses the same `conversation_id` (verified:
  one task = 20 rows / 1 conversation). A fresh start / reset mints a new
  `conversation_id` (verified: one task = 10 rows / 6 conversations). Counting
  raw rows would badly over-count.
- `agent_prompts.cli_session_id` **equals** `agent_sessions.conversation_id`
  (898/904 rows matched, 904/904 populated) → per-session message counts and
  drill-in join cleanly on `conversation_id`.
- Exclude noise: rows with `conversation_id IS NULL` (`pending-spawn`, transient)
  and rows with empty `task_id` (warm pool). Honored origins already encoded in
  `getCurrentConversationId`.
- Read op already exists — `listConversationHistory(db, taskId, mode)` in
  `packages/domains/task/src/server/ops/agent-sessions.ts:59`, exported from
  `@slayzone/task/server` (index.ts:53). **Not exposed via tRPC yet.**

## Plan

### 1. Server: session-list op returning one entry per session
`packages/domains/task/src/server/ops/agent-sessions.ts`
- Add `listTaskSessions(db, taskId, mode)`: GROUP BY `conversation_id`, one row per
  session, newest first. Per session return:
  - `conversationId`
  - `origin` (min/first origin for the group — or the honored origin)
  - `startedAt` = `min(created_at)`
  - `lastActiveAt` = `max(created_at)`
  - `messageCount` = correlated count from `agent_prompts` where
    `cli_session_id = conversation_id AND task_id = ?`
  - `firstPrompt` = earliest `agent_prompts.text` for that session (preview label)
  - `isCurrent` = matches `getCurrentConversationId` result
  - Filter: `conversation_id IS NOT NULL AND task_id = ? AND mode = ?`.
- Export from `packages/domains/task/src/server/index.ts`.
- Keep `listConversationHistory` untouched (audit-trail semantics differ).

### 2. tRPC: expose it + a change subscription
New router `packages/shared/transport/src/server/routers/agent-sessions.ts`
(mirrors `agent-prompts.ts` shape):
- `agentSessions.list({ taskId, agentId })` → `listTaskSessions`.
- `agentSessions.onChanged` subscription → refetch on session spawn/confirm/reset.
  Add a `TypedEmitter` (`agentSessionsEvents`) in `@slayzone/task/server`, emitting
  the `taskId`, fired from `recordSessionSpawn`, `confirmSessionConversation*`, and
  the reset path (`session_resets` write). Router subscribes and emits taskId per
  the `agentPrompts.onChanged` pattern.
- Register in `router.ts` as `agentSessions`.

### 3. Client hook
`packages/domains/task-terminals/src/client/agent-sessions/useTaskSessions.ts`
(mirror `useAgentPrompts.ts`): `useQuery(agentSessions.list)` +
`useSubscription(onChanged)` gated by `enabled`. Returns session list.
- Derived `sessionCount = data.length` used to gate the toggle button.

### 4. Client UI: button + sidebar
New `packages/domains/task-terminals/src/client/agent-sessions/SessionsSidebar.tsx`:
- `SessionHistoryToggleButton` — same `IconButton` (ghost, size-7, size-3.5 glyph)
  as `AgentPromptsToggleButton`. Icon: `History` (lucide). aria-label
  `"Show sessions sidebar"`.
- `SessionsSidebar` — same shell/width (`w-72`, `border-l`, `bg-surface-1`, 10-high
  header w/ "Sessions" label + `X` close). Body: list of session cards, newest
  first, each showing: first-prompt preview (fallback origin label), relative
  started-at, message count, a "current" badge on the active session.
  Empty state guarded (won't show since button only appears when > 1).
- `useSessionsSidebarOpen(taskId)` — same localStorage pattern, distinct key
  `slayzone:sessions-sidebar:${taskId}`.

### 5. Wire into TerminalContainer
`TerminalContainer.tsx`:
- Add `const sessions = useTaskSessions(taskId, mainMode, canShowPrompts)` (only
  query when the main agent is a capture-capable terminal agent — same gate).
- `const canShowSessions = canShowPrompts && sessions.length > 1`.
- In `rightContent`, render `SessionHistoryToggleButton` next to
  `AgentPromptsToggleButton` (both hidden when their sidebar is open).
- Dock `SessionsSidebar` beside `AgentPromptsSidebar` — both can be open at once
  (side-by-side, independent open state). Order: terminal | Sessions | Messages
  (or Messages | Sessions — pick one, keep consistent).

### 6. Tests (TDD — write failing first)
- Server unit: `listTaskSessions` collapses resume re-spawns to one entry, counts
  messages, excludes null-conv + pooled rows, flags current. Seed the two live
  shapes (20-rows/1-session, 10-rows/6-session).
- Router contract test for `agentSessions.list`.
- e2e: task with ≥2 sessions shows the button; single-session task does not;
  click opens sidebar listing sessions. (Gate on the > 1 rule explicitly.)

## Scope notes
- Terminal-agent path only (matches the message-history button's `canShowPrompts`
  gate). Chat-mode `ChatPanel` has no header toolbar and is out of scope here —
  flag if you want it there too.
- Drill-in (click a session → view just its messages) NOT in v1 unless wanted
  (Q2). v1 = list only.

## Decisions (locked)
1. **Sidebars dock side-by-side** — Sessions + Messages can both be open at once,
   two panels right of the terminal. NOT mutually exclusive. Independent
   localStorage open state each.
2. **List-only v1** — no drill-in. Session cards show preview + time + msg count +
   current badge; no click-through to per-session messages.
3. **First-prompt preview** as card title (fallback to origin label if a session
   has no captured prompt).
4. **Proper session emitter** — add a `TypedEmitter` in `@slayzone/task/server`
   fired on `recordSessionSpawn` / `confirmSessionConversation*` / reset, so
   spawned-but-unused sessions refresh live. `agentSessions.onChanged` bridges it.
