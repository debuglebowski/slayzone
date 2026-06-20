# Agent Prompts Sidebar

## Goal
Toggle button in the agent-terminal tab bar opens a sidebar listing **all user
prompts sent to the MAIN agent**. Terminal (PTY) providers only — never chat
modes. Read-only list (per locked decisions).

## Locked decisions
- **Source:** agent `UserPromptSubmit` hook (clean, exact text). Reliable:
  Claude Code, Codex. Best-effort: Gemini, OpenCode. No capture (no hooks):
  Cursor, Qwen, Copilot, Antigravity.
- **Location:** inside the terminal panel — toggle in tab bar, sidebar docks
  beside the terminal. Only for terminal (non-chat) main tabs.
- **Interaction:** read-only list.

## Why hooks (not raw PTY stdin)
`notify.sh` already forwards the full hook payload as `raw` to
`POST /api/agent-hook`; Claude's `UserPromptSubmit` payload carries `prompt`.
Raw xterm stdin is deliberately dropped elsewhere (`isCleanPrompt`) — it can't
reconstruct ↑-history / edits / pastes. Hooks give exact text for free.

## Architecture (mirror the `agent-turns` domain)

### 1. DB — migration 146 (`migrations.ts`, latest is 145)
```sql
CREATE TABLE agent_prompts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id    TEXT NOT NULL,            -- mode: claude-code | codex | ...
  cli_session_id TEXT,                  -- upstream CLI session id (optional)
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_agent_prompts_task ON agent_prompts(task_id, created_at ASC);
```
Cap per task (prune oldest beyond ~500).

### 2. New domain `@slayzone/agent-prompts`
- `shared/types.ts` — `AgentPrompt` row type; `PROMPT_CAPTURE_MODES` set;
  `extractPromptText(agentId, hookEvent, raw): string | null`
  (claude/codex → `raw.prompt`; gemini/opencode → best-effort field; else null).
- `server/db.ts` — `insertPrompt`, `listPromptsForTask`, prune.
- `server/events.ts` — `agentPromptsEvents` TypedEmitter, `'changed' → taskId`.
- `server/capture.ts` — `capturePrompt(db, {agentId, hookEvent, taskId, sessionId, raw})`
  → extract → insert → prune → emit. No-op when text null/empty or no taskId.
- `server/index.ts`, `client/useAgentPrompts.ts` (query + `onChanged` sub →
  refetch), `client/index.ts`, package barrel + `package.json`/`tsconfig`.

### 3. Capture wiring
Call `capturePrompt(...)` inline in `agent-hook.ts` POST handler (where `raw`
is fresh + `taskId`/`agentId` known) — same shape as the existing
`persistConversationId` inline call. Best-effort, never throws into the hook.

### 4. tRPC
`routers/agent-prompts.ts`: `list({ taskId })` query + `onChanged` subscription
wrapping `agentPromptsEvents`. Merge into root `router.ts`.

### 5. UI (in `task-terminals`, inside `TerminalContainer`)
- Toggle button composed into the `rightContent` handed to `TerminalTabBar`,
  shown only when `activeGroup.isMain` **and** main-tab mode ∈ capture modes
  (non-chat).
- Sidebar = sibling of the `flex-1` terminal column in the root `flex` div;
  ~280px, `border-l border-border`, scrollable list via `useAgentPrompts(taskId)`.
  Items read-only, text wrapped, muted timestamp. Theme tokens only.
- Open/closed state held in `TerminalContainer` (persisted per-task — see Q4).

### 6. Registration / plumbing
- `electron.vite.config.ts` → `externalizeDepsPlugin({ exclude: [...] })` add
  `@slayzone/agent-prompts` (required, else runtime fail).
- Root tRPC router merge.
- No Tailwind `@source` change — UI lives in `task-terminals` (already scanned);
  new pkg ships only a hook + server.

### 7. Tests (TDD — fail first)
- unit: `extractPromptText` per agent; db insert/list/prune.
- e2e: open claude-code main tab → `POST /api/agent-hook` UserPromptSubmit →
  toggle sidebar → assert message shows. Assert button hidden on a chat tab.

## Verify during impl
- Exact `prompt` field name in Codex / Gemini / OpenCode UserPromptSubmit payloads.
- Confirm Antigravity carries no usable user prompt (→ excluded).

## Unresolved questions
- Q1: order — newest on top, or chronological (oldest top)?
- Q2: persist sidebar open/closed across app restart, or session-only?
- Q3: main agent only, or also same-task split-pane agents? (decision implies main)
- Q4: show the toggle for terminal agents that can't capture (empty sidebar), or hide it?
