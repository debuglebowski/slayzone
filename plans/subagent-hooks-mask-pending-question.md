# Background subagent hooks mask "agent is waiting for your answer"

## Symptom

A task's dot shows the green spinner ("Active") while the agent is actually parked on an
unanswered question. The amber "Unread" cue never appears.

## Root cause (CONFIRMED from live diagnostics, not inferred)

A Claude Code session is a **tree**: one main loop + N *concurrent background subagents*,
all sharing one PTY, one session id, one `SLAYZONE_AGENT_HOOK_CONTEXT`. Every hook they
fire is indistinguishable to `processAgentHook` today, so **subagent activity overwrites the
main loop's "parked on a question" state**.

Measured window, task `d5f37faf` ("Personal cloud computers"), session `6feb84ca`, 2026-08-12
(dev hub `slayzone.dev.diagnostics.sqlite`):

| time | event | effect |
|---|---|---|
| 16:11:03 | main `PreToolUse AskUserQuestion` | `running → idle` ✅ correct |
| 16:11:09 | main `Notification` | idle ✅ |
| **16:12:54** | **subagent `PreToolUse Bash`** | **`idle → running`** ❌ spinner back on, attention wiped |
| 16:12:54–16:21:46 | ~300 subagent hooks (`SubagentStop` ×3 confirm origin) | pinned `running` |
| 16:49:36 | user answers → `PostToolUse AskUserQuestion` | `running` |

**37 minutes of green spinner while the agent sat waiting for an answer.**

Three distinct consequences, one cause:

1. **Spinner lies** — `PreToolUse → 'running'` (immediate, un-debounced) beats the queued `idle`.
2. **"Needs you" cue is erased** — `handleAttentionTransition` clears `needs_attention` on
   `* → running` (`attention.ts:34-38`), so the amber dot the pause had just earned is wiped.
3. **Hibernation gate is unsafe** — `hookToAwaitingUser` returns `false` for any non-blocking
   `PreToolUse`, so a subagent clears the awaiting-user latch and a task parked mid-question
   becomes eligible for idle-close.

### The discriminator (verified)

Claude Code stamps subagent hook payloads with `agent_id` + `agent_type`; main-loop hooks carry
**neither**. Clean separation across the whole diagnostics history:

```
PreToolUse    → running       main      9635      PreToolUse   → running   SUBAGENT  2894
PostToolUse   → mark-active   main      9395      PostToolUse  → mark-act. SUBAGENT  2873
UserPromptSubmit/Stop/Notification/SessionStart/SessionEnd/PreCompact  main ONLY
SubagentStop  → mark-active   SUBAGENT   622
agent_type seen: general-purpose, Explore, Plan, workflow-subagent
```

Subagents emit **only** `PreToolUse` (the bug), `PostToolUse` and `SubagentStop` (both already
harmless no-ops). Blocking-tool `PreToolUse` (60) and every turn-boundary event are main-only.

Ruled out by measurement first: hook mapping is correct (47/47 `AskUserQuestion` → idle,
13/13 `ExitPlanMode` → idle); zero dropped hooks (every blocking tool_use in every recent
transcript has its hook); no renderer desync (live CDP dot states match backend exactly);
`useTerminalStateStore` self-heals every 15s.

## Fix — DONE

State stops being a function of the last hook and becomes **derived** from per-session facts,
with a new `background` state so the dot never has to lie in either direction.

New pure model `terminal/src/server/agent-tree.ts` — three facts per session
(`mainWorking`, `awaitingUser`, `subagents: Set<agent_id>`) and one explicit ladder:

| condition | state | meaning |
|---|---|---|
| `awaitingUser` | `idle` + amber | **needs me** — outranks all activity |
| `mainWorking` | `running` | main loop working |
| `subagents.size > 0` | `background` | work in flight, nothing needs me |
| — | `idle` | done |

`awaitingUser` outranking activity is the fix. A subagent hook may ONLY add/remove its own
`agent_id`; it can never set `mainWorking` nor clear `awaitingUser`.

Subagent liveness is tracked by identity, not a counter: every subagent hook carries `agent_id`
and `SubagentStop` carries the same id (400/400 verified), so a missed event can't corrupt a
count, a repeat can't double-count, and the last `SubagentStop` drains `background` → `idle`
(no stuck state).

Landed:
1. `agent-tree.ts` + `subagentIdOf(raw)` (the `agent_id` discriminator); `CLAUDE_BLOCKING_TOOLS`
   moved here — pause AND resume now derive from that one set.
2. `agent-hook.ts` — one tree per session (this route is already the single authority for
   hook→state, shared by the Express route and the hub ws relay, so no bridge surface was added
   and there is exactly one writer). Evicted on `SessionEnd`.
3. `hookToAwaitingUser` for claude now READS the tree instead of re-deriving from the event —
   ONE truth, and the hibernation gate inherits the fix (a task parked mid-question can no
   longer be idle-closed by a helper reporting "not blocked").
4. `TerminalState` gains `background`; `attention.ts` treats it as a working ORIGIN (so a turn
   that ends with helpers running still earns the amber cue on its final `→ idle`) but never as
   a clearing destination (helper work must not erase the cue).
5. UI: dimmed half-speed spinner + "Background work" label; `agent-panels` status maps; store
   `ALIVE_STATES` += `background` (else a dropped exit would never converge to dead).
6. `pty.hook_received` diagnostics now record `subagent {id,type}` + the live tree — diagnosing
   this required cross-checking the agent's own transcript.

## Tests — all green

- `agent-tree.test.ts` (NEW, 15): the ladder, incl. "a helper cannot resume a main loop parked
  on a question", reject/Esc stays parked, drain-to-idle, unknown/repeat `SubagentStop`.
- `agent-hook-attention.test.ts` (+5, full chain hook → transition → DB flag): the 3 new ones
  failed first with exactly the reported symptom (`Expected "idle", got "running"`).
- `agent-hook.test.ts` 71/71 — its `@slayzone/terminal/server` mock now delegates to the real
  agent-tree module (the barrel's node-pty can't load under vitest) so the mock can't drift.
  Two assertions moved from "not called" to "never latched `true`": the latch is now re-asserted
  from the tree on every hook, so the value is the guarantee, not the call count.
- Registered `agent-tree.test.ts` AND `useTerminalStateStore.test.ts` in `run-all.sh` — the
  latter's 22 assertions were never in `test:unit` (pre-existing gap, in a file this change
  touches).
- `pnpm typecheck` clean (it caught two exhaustive `Record<TerminalState, …>` maps).

## Not verified

Live end-to-end in the running dev app: the fixed code is in the transport/terminal packages
the hub sidecar serves, so proving it live needs a hub/dev-app restart — which would kill all
17 live agent PTYs (including the session that made this change). Left to the user.

Chat mode (`useChatSession` / `chat-handlers`) has its own SDK-driven state, not this hook
path; whether it has an analogous main-vs-subagent conflation was NOT investigated.

## Decisions taken

1. Main loop done + helper still working → `background` (its own state), not `running`/`idle`.
2. `needs_attention` clear-on-`running` left as-is; root cause removed instead.
