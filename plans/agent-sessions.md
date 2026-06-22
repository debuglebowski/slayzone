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

## Entity model: B (session entity, not event ledger) — DECIDED

`agent_sessions` = **one row per spawn** (one live process), NOT one row per
conversation-provenance event. This is the correction to slices 1–2 (which built
an append-only mirror of `task_conversations`). Rationale + robustness proof in
the conversation history; summary:

- `id` = the runtime PTY key (main-minted uuid), 1:1 with a live process.
- The row's lifecycle: `pending` (at spawn) → conversation_id + origin filled
  **write-once** on turn-init → `dead` on exit. The ONLY mutations are this
  write-once conversation fill + the `status` lifecycle. A new spawn = a NEW row
  (still append *across* spawns), so the cross-session clobber bug stays
  structurally impossible; provenance gate + reset cutoff are unchanged.
- `task_conversations` retires INTO this (its append-of-events granularity was a
  mechanism detail, not a robustness feature worth keeping).

**Write lifecycle (replaces the slice-1 event triple-write):**
- spawn → `recordSessionSpawn` INSERT (origin=`pending-spawn`, status=`bound`|`pooled`,
  pending_meta={expectedId, usedResume}, conversation_id=expectedId|null).
- turn-init → `confirmSessionConversation` UPDATE write-once (conversation_id=observed,
  origin = match?`slay-spawned-fresh`/`-resume`:`foreign-observed`).
- exit → `markSessionDead` (status=`dead`, ended_at).
- pool assign (slice 4) → `bindSessionToTask` (task_id, tab_id, bound_at, status=`bound`).

Readers (resolver / history / pending) from slice 2 already target
`agent_sessions` + `session_resets` and stay correct for B rows. `findPendingSpawn`
gains a not-dead filter (in-flight only).

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

### Slice 3 — DECISION: runtime-key surgery DROPPED (path A)

The session **entity** (`agent_sessions`) already has an opaque, backend-minted,
task-independent id (slices 1–2 + B foundation) — the architectural goal is met
at the data layer. Flipping the **in-memory PTY registry key** from `taskId:tabId`
to that opaque id was found to be atomic, 1947-LOC surgery on the live-dogfooded
`Terminal.tsx` (93 `sessionId` uses) for a plumbing-purity gain only. The pool
does NOT need it — pooled sessions are keyed by their opaque uuid in the runtime
and **adopted** into the task's `taskId:tabId` session on assignment (the proven
`warm-process-manager` pattern). So:

- **KEPT** as pool foundation (behavior-neutral): the seam
  (`sessionTaskMap`/`sessionTabMap`, map-first derivation), `pty.create` minting
  an opaque id when none is supplied + returning it + accepting explicit
  `taskId`/`tabId`, `listPtys`/enricher using the seam.
- **DROPPED**: the renderer flip (Terminal.tsx / container / selectors / parse
  sites). Bound sessions keep the `taskId:tabId` runtime key. The entity id
  (`agent_sessions.id`) ≠ runtime key for bound sessions — accepted; the entity
  is the source of truth, the runtime key is plumbing.

### Slice 3 — original full-flip design (NOT pursued; kept for reference)

**Identity.** Runtime PTY key = `agent_sessions.id` (opaque uuid). Never encodes
taskId/tabId. STABLE for the session's whole life → pool assignment is just
`UPDATE agent_sessions SET task_id=…` + an in-mem map update; the live process
is never re-keyed. (Re-keying — what keeping `taskId:tabId` would force on every
assignment — is the hack we avoid.)

**Schema (v148).** `agent_sessions` gains nullable `tab_id` (which pane). With
`task_id` already present: pooled = both null. "Current sessionId for tab T" =
latest live `agent_sessions WHERE tab_id=T` after any reset. `terminal_tabs`
structure unchanged; the `taskTerminals.list` query returns each tab's current
sessionId (subquery/JOIN) so the renderer stops *constructing* the id and starts
*reading* it.

**`sessionId` is two different uses — only the encoder breaks:**
- *Opaque key* (sessions map, dataListeners, event routing, store `byId`,
  PtyContext subs, `claimSession`): already format-agnostic. No change.
- *taskId/tabId encoder* (~40 `split(':')`): rewire to a lookup.

**Main side.** `sessionTaskMap`/`sessionTabMap` (Map<sessionId,…>) populated at
`createPty` (taskId/tabId are explicit there) + rehydrated on boot from
`agent_sessions`. `taskIdFromSessionId`/`resolveTabRowId`/`isMainTabSession`
read the map, FALLBACK to `split(':')` for legacy ids (dual-accept during
transition; in-memory runtime state dies on restart anyway, so legacy
`taskId:tabId` keys age out). `attention.ts:26`, `pty-store.ts:311` (warm-pool
project lookup), task-terminals enricher: take taskId explicitly / via map.

**Renderer.** `getSessionId(tabId)` returns the tab's current sessionId (from the
tabs query) instead of `${taskId}:${tabId}`. The two fragile selectors —
`useActiveTaskIds` + `useTaskTerminalState(taskId)` — use a `sessionId→taskId`
reverse map derived from the tabs list (each tab carries taskId + sessionId).
Parse sites: `TerminalStatusPopover` uses the `pty.taskId` field already on the
list payload; `TerminalContainer:363` uses a `data-task-id` attr / tab lookup,
not `substring`.

**RESOLVED sub-decisions:**
1. *Who mints `agent_sessions.id`* → **MAIN mints.** Session identity is a
   backend entity; the frontend must not own it. Decisive: a POOLED session is
   created with no renderer/tab in existence, so a frontend mint is structurally
   impossible. Consequence: `pty.create` becomes request/response — main mints
   the uuid, writes `agent_sessions`, returns the sessionId; the renderer awaits
   it before subscribing. Pool path mints server-side via the same code, no tab
   involved. (The conversation/thread id `agent_sessions.conversation_id` was
   already main-minted — now the runtime key joins it: one backend authority.)
2. *Main-tab `terminal_tabs.id === taskId` convention* → **keep it** (harmless now
   that sessionId isn't derived from it; less churn).
3. *Transition* → **dual-accept** (map + split fallback), legacy keys age out on
   restart. No destructive runtime migration.

**Slice 4 — agent pool (adoption-based).** Extend the EXISTING warm-process
mechanism, do NOT build a parallel pool.

Today `warm-process-manager.ts` pre-warms a bare login *shell* per project; the
agent (claude) only `exec`s at adoption — so MCP init + model handshake still
cost at adoption. The pool warms one step further: the **agent itself** is
already running (claude booted, MCP up, idle) so assignment is instant.

- A pooled agent = a spawned session with `agent_sessions` row (opaque id,
  `task_id=null`, `status='pooled'`), process keyed by its opaque uuid in the
  runtime `sessions` map (no task → no `taskId:tabId`).
- Warm scope: one pool per `(project-already-running-an-agent, mode)` + a
  scratch cwd for projectless temp tasks. Cold projects warm nothing.
- **Assign = adopt** (the warm-shell pattern, extended): on task/main-tab spawn,
  if a matching pooled agent exists, re-key its process from the opaque uuid to
  the task's `taskId:tabId` session in the `sessions` map, `bindSessionToTask`
  (set task_id/tab_id, status=bound), skip cold spawn. Renderer untouched.
- Boot reaper: pooled rows are live OS processes → all dead on restart; mark
  `status='dead'` for orphaned `pooled` rows on boot.
- Refill/cap/TTL per `(cwd, mode)`.

Scoping (DECIDED): K=1 per active project; claude-code only; project cwd;
**no idle TTL** — warm agent lives while the project has ≥1 open task tab, reaped
when it drops to zero (this is already the warm-shell `reconcile` lifecycle).
Project-scoped only (no scratch/projectless warming in v1).

### Slice 4 — path B: TRUE agent pre-warm (DECIDED)

The existing pool warms a bare **shell** and `exec claude` only at adopt (so
`SLAYZONE_TASK_ID` is set at launch). Path B pre-warms the **agent** (claude
booted, MCP up, idle) so assignment is instant. The blocker: agent task identity
(`SLAYZONE_TASK_ID`) is launch-time + un-mutable on a running process, and is
read by the `slay` CLI + the conversation hook.

**Solution — dynamic session→task resolution (no file):**
- Launch a pooled agent with `SLAYZONE_SESSION_ID=<runtime uuid>` (immutable,
  known at launch) and NO `SLAYZONE_TASK_ID`.
- `slay` CLI resolves task = `$SLAYZONE_TASK_ID ?? resolveTaskForSession($SLAYZONE_SESSION_ID)`
  via the local API. Source of truth = `agent_sessions.task_id`. Normal
  (non-pool) agents keep the fast env path untouched.
- Conversation capture keys off the runtime session id (turn-init →
  `confirmSessionConversation({sessionId})`), NOT the task env — works for a
  taskless pooled agent.
- Adopt = `bindSessionToTask` (sets `task_id`/`tab_id`) + re-key the process
  (opaque uuid → `taskId:tabId`, the warm-shell adoption pattern). The CLI's
  session→task query then returns the bound task instantly.

**Decomposition (safe sub-steps):**
- **B1** — `slay` CLI session→task fallback + a local API endpoint resolving
  `agent_sessions.id → task_id`. Independent, unit-testable. Foundation.
- **B2** — spawn path writes the `agent_sessions` row (`recordSessionSpawn`) +
  exports `SLAYZONE_SESSION_ID`; wire turn-init → `confirmSessionConversation`,
  exit → `markSessionDead` (model-B conversation cutover, spawn path).
- **B3** — warm-process-manager warms the agent (claude) instead of the shell:
  pre-mint conversation id, launch claude pooled (no task env), `status='pooled'`.
- **B4** — adopt: `claimWarmAgent` → `bindSessionToTask` + re-key + the running
  agent's `slay` calls resolve the now-bound task.
- **B5** — pool lifecycle (reuse `reconcile`) + boot reaper for orphaned
  `pooled` rows.

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
