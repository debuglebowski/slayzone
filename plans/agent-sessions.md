# Agent Sessions — decouple sessions from task IDs + warm pool

## Goal

Make an **agent session** a first-class entity with its own durable identity,
independent of any task. Today a session's identity *is* `taskId:tabId` and its
conversation history lives in the `task_conversations` ledger keyed by task. We
lift the session out so that:

1. **History** — list every session ever bound to a task (already a query today;
   becomes `WHERE task_id = ?` on the new entity).
2. **Pool** — pre-warm provider processes that exist *before* any task, then
   assign one to a task on creation (esp. temporary tasks).

Decisions locked with the user:

- **Single source of truth.** Retire `task_conversations`; fold its provenance
  ledger into the new `agent_sessions` entity. (Option B, not "add a table
  above the old one".)
- **Our-minted id is the key.** `agent_sessions.id` = a UUID we mint at spawn,
  durable from birth (the pool process has no provider thread id yet). The
  provider thread/conversation id is a *nullable attribute* that fills in on
  `turn-init`. **Keep Claude/Qwen pre-mint** (`--session-id {id}`) — it yields a
  binary-exact provenance match, stronger than the codex null-window heuristic.
  Do NOT flip Claude to provider-mint.
- **Set-once task binding, no reattach.** `task_id` is NULL while pooled, set
  exactly once on assignment, never moves. → `WHERE task_id = ?` is the full,
  clean per-task history.
- **Reset = explicit timeline event** (Option 1), not a `status='dead'` flag.
  Normal process exit ≠ "forget this conversation"; every closed session stays
  resumable. Reset is an event on the (task, mode) timeline, modeled as its own
  thing — not a property mutated on the old sessions.
- **Pool keyed by `(cwd, mode)`.** A live agent is spawned in a fixed cwd and
  cannot be rehomed. So warm only where the cwd is already in use: **one pool
  per project that already has a running agent** + the scratch/home cwd for
  projectless temp tasks. Cold projects pay nothing.

## Current model (recap, verified)

- `task_conversations` (migration v145), append-only, FK `task_id`, columns
  `id, task_id, mode, conversation_id, origin, pending_meta, created_at`.
  - `origin` ∈ {slay-spawned-fresh, slay-spawned-resume, cas-repoint-heal,
    legacy-migration, foreign-observed, manual-reset, pending-spawn}.
  - HONORED = {fresh, resume, heal, legacy}.
  - Resolver `getCurrentConversationId` = latest honored row strictly after the
    newest `manual-reset` (cutoff is structural SQL, not a JS filter).
  - `recordConversation` dual-writes honored rows into the legacy
    `provider_config.{mode}.conversationId` JSON + `{mode}_conversation_id`
    column (transition shim, was to be deleted in a later slice).
  - `pending-spawn` rows = provenance anchor written *before* process start;
    TTL 10min (pre-minted id) / 30s (null-expected). `findPendingSpawn`,
    `prunePendingSpawns`.
  - File: `packages/domains/task/src/server/ops/task-conversations.ts`.
  - Origins enum: `packages/domains/task/src/shared/conversation-origins.ts`.
- Pure fresh-vs-resume decision: `resolveSpawnConversation` in
  `packages/domains/terminal/src/server/spawn-conversation.ts` (the
  restart-clobber invariant: known id ⇒ resume, never mint over it).
- **Session key = `taskId:tabId`.** taskId is recovered everywhere by
  `sessionId.split(':')[0]` — **~30 sites**: `pty-manager.ts` (taskIdFromSessionId,
  many call sites), `pty-store.ts:311`, `task/server/attention.ts:26`,
  client `useTerminalStateStore.ts:29/221`, `TerminalStatusPopover.tsx:141`.
  Main tab: `tabId === taskId`.
- Migration mechanism: versioned array, synchronous `up:(db)=>{}` over
  better-sqlite3. **Current max version = 146.** New = 147; drop-legacy = a
  later version (148+).

## Target schema

```sql
-- The session entity. One row per spawned provider process. Append-only.
CREATE TABLE agent_sessions (
  id              TEXT PRIMARY KEY,   -- our minted uuid = PTY session key
  mode            TEXT NOT NULL,      -- claude-code / codex / gemini / ...
  cwd             TEXT NOT NULL,      -- spawn working dir = pool key
  task_id         TEXT,              -- NULL while pooled; set ONCE on assign; no reattach
  conversation_id TEXT,              -- provider thread id; fills on turn-init
  origin          TEXT NOT NULL,      -- provenance; HONORED set decides resume
  status          TEXT NOT NULL,      -- pooled | bound | dead
  pending_meta    TEXT,              -- {usedResume, spawnedAt} for in-flight match
  created_at      INTEGER NOT NULL,
  bound_at        INTEGER,           -- when task_id was set (NULL until assigned)
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  CHECK (origin IN (
    'slay-spawned-fresh','slay-spawned-resume','cas-repoint-heal',
    'legacy-migration','foreign-observed','pending-spawn'
  )),
  CHECK (status IN ('pooled','bound','dead'))
);
CREATE INDEX agent_sessions_task   ON agent_sessions (task_id, mode, created_at DESC);
CREATE INDEX agent_sessions_pool   ON agent_sessions (cwd, mode) WHERE status = 'pooled';
CREATE INDEX agent_sessions_pending ON agent_sessions (task_id, mode, conversation_id) WHERE origin = 'pending-spawn';

-- Reset as an explicit timeline event (Option 1). NOT a session.
-- A reset is per (task, mode): "forget everything before now."
CREATE TABLE session_resets (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  mode       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX session_resets_lookup ON session_resets (task_id, mode, created_at DESC);
```

Note `manual-reset` drops out of the `origin` CHECK — it's now a `session_resets`
row, not a session. (`origin` keeps the 6 real provenances.)

### Resolver (ported, semantics identical)

```sql
WITH reset AS (
  SELECT max(created_at) AS at FROM session_resets
   WHERE task_id = ? AND mode = ?
)
SELECT conversation_id FROM agent_sessions
 WHERE task_id = ? AND mode = ?
   AND conversation_id IS NOT NULL
   AND origin IN ('slay-spawned-fresh','slay-spawned-resume','cas-repoint-heal','legacy-migration')
   AND created_at > coalesce((SELECT at FROM reset), 0)
 ORDER BY created_at DESC LIMIT 1
```

Same structural cutoff. The gap case (reset, then reopen before any new session)
correctly returns NULL → fresh spawn, because no session row is newer than the
reset. Port the existing `task-conversations.test.ts` cases onto this verbatim.

## Decoupling the PTY key (the ~30 sites)

The session id stops carrying the taskId. taskId now comes from
`agent_sessions.task_id`. Hot path can't hit the DB on every event, so:

- pty-manager owns an in-memory `Map<sessionId, taskId | null>`, the
  authoritative mirror of `agent_sessions.task_id`. Populated on spawn, on
  assignment, and rehydrated on boot from DB. A pooled session maps to `null`.
- `taskIdFromSessionId(sessionId)` becomes `sessionTaskMap.get(sessionId) ?? null`.
  Every `sessionId.split(':')[0]` site reads the map instead. Sites that report
  task-scoped state (attention, status popover) become no-ops for `null`
  (pooled sessions have no task to attribute to — correct).
- Renderer: tab↔session is renderer state already (terminal store keys by
  sessionId). It stops assuming `tabId === taskId`. **Needs an impl-time read of
  the renderer terminal store** to enumerate every `taskId === tabId` / split
  assumption before touching it — flagged as a sub-task, not yet fully specced.

## Pool

- `AgentPoolManager` (new, terminal domain server). Per `(cwd, mode)`:
  - Maintains up to K warm `pooled` sessions: spawned process + MCP init +
    model handshake done, sitting at idle, `task_id = NULL`.
  - Only warms a `(cwd, mode)` that already has ≥1 running bound session
    (project in active use) + the scratch cwd for projectless temp tasks.
    Never warms cold projects.
  - Idle TTL: reap a pooled session after N min unused.
- **Assignment** (temp-task-first): on task create, if a matching `(cwd, mode)`
  pooled session exists → claim it atomically (set `task_id`, `bound_at`,
  `status='bound'`, update the in-memory map), wire its PTY to the task's tab.
  Else cold spawn (today's path). Refill the pool async after a claim.
- **Crash reaping**: pooled rows are live OS processes that die on app restart.
  On boot, mark all `status='pooled'` rows `dead` (their processes are gone).
  Reuse/extend the pending-spawn boot sweep.

## Migration plan (phased, reversible, drop-late)

Slices land independently; each is shippable and reversible until the final drop.

**Slice 1 — schema + backfill + triple-write (v147). Zero behavior change.**
- Migration v147: create `agent_sessions` + `session_resets`. Backfill from
  `task_conversations`: one `agent_sessions` row per non-pending, non-reset row
  (reuse the source row `id` as `agent_sessions.id` → idempotent, stable; carry
  `task_id, mode, conversation_id, origin, created_at`; `status='dead'`,
  `cwd=''` for historical rows — they're audit-only, never resumed live);
  each `manual-reset` row → a `session_resets` row. Backfill from legacy
  `provider_config` / `*_conversation_id` is unnecessary (v145 already pulled
  them into `task_conversations`; we backfill from there).
- New ops module `agent-sessions.ts` mirroring every `task-conversations.ts`
  fn (record, resolver, history, pending, prune) against the new tables.
- `recordConversation` / `recordPendingSpawn` / reset writer write to BOTH old
  and new tables in the same `batchTxn` (transitional triple-write). Reads
  still come from `task_conversations`. Ship + bake.

**Slice 2 — read cutover.** Resolver, history, pending-find read `agent_sessions`
+ `session_resets`. Port tests. `task_conversations` still written (rollback
safety) but no longer read. Verify resume + history parity in prod.

**Slice 3 — PTY key decoupling.** Session id = `agent_sessions.id`; introduce the
in-memory `sessionId→taskId` map + boot rehydration; replace all
`split(':')[0]` sites (main + renderer). Riskiest slice; isolate it. Heavy e2e
on resume / reset / multi-tab / multi-mode.

**Slice 4 — pool.** `AgentPoolManager`, assign-on-create for temp tasks, boot
reaper, refill/cap/TTL. New feature on the now-decoupled model.
> ⚠️ A warm-process pool ALREADY EXISTS: `warm-process-manager.ts` (+ tests
> `warm-process-manager.test.ts`, `adopt-pty.test.ts`, `createpty-resolver.test.ts`),
> "per-project gate + adopt-match" — it pre-warms *shells* per project and
> `createPty` adopts a matching warm shell. Slice 4 must EXTEND this (warm the
> agent, not just the shell + bind via agent_sessions) — NOT build a parallel
> pool. Read it first.

**Slice 5 — drop legacy (v148+).** After prod proves slices 2–4: drop
`task_conversations`, the `*_conversation_id` columns, and the
`provider_config.{mode}.conversationId/chatConversationId` dual-write branch.
Separate, later migration — old data survives until proven. No version skipped
(per the migration-skip footgun: never commit a higher migration before a
lower in-flight one).

## Files touched (initial map)

- `packages/shared/transport/src/db-bootstrap/migrations.ts` — v147 (+v148 later).
- `packages/domains/task/src/server/ops/agent-sessions.ts` — NEW ops module.
- `packages/domains/task/src/server/ops/task-conversations.ts` — triple-write,
  then deleted in slice 5.
- `packages/domains/task/src/shared/conversation-origins.ts` — drop
  `manual-reset` from `ConversationOrigin` (now a reset table), update CHECK
  sync test.
- `packages/domains/terminal/src/server/runtime/pty-manager.ts` — session id
  source, sessionId→taskId map, ~all `taskIdFromSessionId` sites.
- `packages/domains/terminal/src/server/runtime/pty-store.ts:311`,
  `task/server/attention.ts:26` — map lookup.
- `packages/domains/terminal/src/server/spawn-conversation.ts` — unchanged logic,
  fed from new resolver.
- `packages/domains/terminal/src/server/runtime/agent-pool-manager.ts` — NEW.
- Renderer: `useTerminalStateStore.ts`, `TerminalStatusPopover.tsx`, tab↔session
  assumptions — impl-time read required.
- Tests: port `task-conversations.test.ts` → `agent-sessions.test.ts`; new pool
  tests; e2e resume/reset/multi-tab.

## Risks

- **Slice 3 is the sharp edge.** ~30 taskId-derivation sites; a missed one
  silently mis-attributes a session to the wrong/no task. Mitigate: central map,
  delete `taskIdFromSessionId`'s string-split so the compiler flags every caller.
- **cwd immutability caps pooling.** Pool only helps shared-cwd tasks. Accepted;
  scoped to per-project-in-use + scratch.
- **Backfill ordering.** Reuse source ids + created_at exactly so resolver picks
  the same "current" as today. Parity test old-resolver vs new-resolver over a
  prod DB snapshot before slice 2.

## Open questions (concise)

1. Pool size K + idle TTL — fixed (e.g. K=1, TTL=10m) or configurable per project?
2. Pool default mode — only `claude-code`, or warm the task's last-used mode?
3. Scratch cwd for projectless temp tasks — `os.homedir()`, app data dir, or a
   dedicated scratch dir?
4. Backfilled historical rows `cwd=''` ok (audit-only, never resumed live), or
   backfill the task's project path?
5. Slice 5 drop — same release as slice 4, or a release later?
