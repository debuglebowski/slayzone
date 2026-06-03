# Plan: Conversation-ID Robustness (fix "Claude Code session expired" false-positive + silent convo loss)

**Status:** approved, implementing. **L1 done** (uncommitted, unreviewed; typecheck green). L0/L2–L6 pending.
Defaults chosen for open Qs: history cap 10 · self-heal silent · L3-forward (+ recover dd45ad7a, deprioritised per user) · extend session record for L0 · ~1s commit-on-SessionStart OK.
**Origin:** prod incident, task `dd45ad7a-2e36-48f7-8910-3262263468ca` ("Prepare for the all tests", Normain Ops). User certain session not expired; overlay shown anyway.

---

## 1. Summary

A healthy Claude conversation can be **silently abandoned**: the task's stored conversation id gets overwritten with a freshly-minted `--session-id` UUID that Claude never persists to disk (the fresh session dies before its first message → `<uuid>.jsonl` is never written). Every subsequent reopen runs `claude --resume <phantom>` → "No conversation found" → the friendly **"session expired"** overlay — while the real transcript sits intact and orphaned on disk.

The session never expired. The app threw away the pointer to it.

Confirmed for `dd45ad7a`: stored id `1bb47f6c…` (missing on disk) clobbered the real `b99e1b83…` (1.7 MB, 1153 msgs, intact). Recovery target verified by content (first msg + cwd + last-resume timestamp).

---

## 2. Confirmed root causes (verified against live source)

### RC1 — Conversation id is committed eagerly and never reconciled with disk *(primary, durable)*
- `terminal/src/client/Terminal.tsx:951` mints `crypto.randomUUID()` (guarded only by `mode!=='terminal' && supportsSessionId && !conversationId && !existingConversationId`, `:945-950`).
- `Terminal.tsx:952` fires `onConversationCreated(newId)` **synchronously, before** `pty.create(...)` is even awaited (`:965`).
- `task/src/client/TaskDetailPage.tsx:1088-1102` `handleSessionCreated` → `updateTask({ providerConfig: setProviderConversationId(...) })` → the UUID lands in `provider_config['claude-code'].conversationId` (+ dual-written legacy `claude_conversation_id`) **before Claude connects, before first prompt, before `<uuid>.jsonl` exists.**
- **No disk reconciliation for Claude.** `ClaudeAdapter` (`adapters/claude-adapter.ts`) implements neither `detectSessionFromDisk` nor `detectConversationId`; `SESSION_ID_COMMANDS` (`shared/types.ts:402-405`) lists only codex/gemini. The stored id is trusted forever.

### RC2 — Cold-revive misclassifies abnormal exits as "cold" and wipes the conv id *(live in 0.33.0, no user intent)*
- `TaskDetailPage.tsx:1263-1285` `onRespawnSuggested` (issue #77 revive after terminal→non-terminal status transition).
- `:1277` `isCold = killedAt == null || Date.now() - killedAt > COLD_RESPAWN_MS` (`COLD_RESPAWN_MS = 30min`, `shared/types.ts:91`).
- `:1278-1279` cold → `handleResetTerminal()` → `:1247-1249` sets `conversationId: null` → remount → RC1 mints a fresh phantom.
- `killedAt` is recorded **only** on a clean host-kill: `app/src/main/index.ts:1430-1437` (`setOnHostKillHandler`), fired only when `exitCode === PTY_EXIT_KILLED_BY_HOST` (`-2`, `pty-manager.ts:439`, finalized at `:2080/:2087`). **Any other exit — crash, non-zero, OS SIGTERM/143 — leaves `killedAt = null` → defaults to cold → conversation wiped.**

### RC3 — SESSION_NOT_FOUND detection is a lifetime-wide substring scan *(contributing; causes false overlays)*
- `claude-adapter.ts:65` — `detectError` = bare `/No conversation found with session ID:/.test(data)`. No line anchor, no exit-code/startup correlation.
- **Live path** `pty-manager.ts:1570` runs on every onData chunk and is **not gated** on `resuming`/`checkingForSessionError`; sets `session.error` + transitions to `'error'`. (Only the `suppressOutput` side-effect at `:1597` is gated on `resuming`.)
- **Exit path** `pty-manager.ts:1781-1785` scans the **entire ring buffer** (`session.buffer.toString()`) at exit.
- `checkingForSessionError` (declared `:139`, set `:1181`) is **never read as a gate** — the intended "only near startup" window is dead code.
- **Race:** node-pty data vs exit are independent events → on a self-terminating resume the phrase sometimes lands in the buffer before onExit (overlay) and sometimes after (shell fallback). Detection is a timing coin-flip.
- **Real false-positive vectors** (all via the ungated live path): (a) `claude --resume` replaying a transcript that contains the phrase; (b) the agent printing/grepping a file containing the literal phrase — it lives in **this repo** (`chat-transport-manager.ts:685`, `qwen-adapter.ts:43`, `claude-adapter.ts:65`), so it's trivially reproducible while dogfooding; (c) pasted content. (b)/(c) flip *any* claude session to `'error'` mid-turn, resumed or not.

---

## 3. Blast radius (prod, read-only audit — this install, the heaviest case)

- 2328 claude-code tasks; 1352 have a stored conv id; **1157 phantom** (stored id absent from all `~/.claude/projects/*`): 308 active, 849 archived.
- **The 1157 is dominated by normal Claude ~30-day retention pruning, NOT this bug.** Only **1** task (`dd45ad7a`) is diagnostically confirmable as bug-induced, because diagnostics resume-history retention spans only ~3 days (2026-06-01→03).
- **No telemetry exists** for the overlay / SESSION_NOT_FOUND / reset → we are blind to true prevalence. Estimate: low-single-digit % of active multi-session users over months, skewed to power users; most won't notice. Confidence: low (reasoned, not measured).

---

## 4. Goals / non-goals

**Goals:** (1) stop silent conversation loss; (2) make recovery automatic and retention-independent; (3) kill false-positive overlays without losing genuine stale detection (#90); (4) become able to *measure* this.
**Non-goals:** removing the friendly overlay or manual "Start fresh" (keep both); changing Claude's own retention; a blind disk-heuristic mass migration (would mis-attach conversations — worse than honest "expired").
**Constraints:** preserve all existing behavior (CLAUDE.md), TDD (failing test first), most-sustainable solution.

---

## 5. The fix — layered

### Layer 0 — Cross-cutting: single conversation-id lifecycle owner *(sustainability spine)*
- The bug exists because conversation-id decisions are scattered across four files (mint in `Terminal.tsx:951`, commit in `TaskDetailPage.tsx:1088`, reset in `handleResetTerminal:1247`, resume/detect in `pty-manager.ts`). Patching each in isolation invites the next variant.
- Introduce **one owner** (a small module in `terminal/main`, or extend the existing session record) for the lifecycle `minted → pending(unconfirmed) → confirmed(persisted) → stale`, with the **on-disk transcript as the reconciliation source of truth**. Every reset / revive / resume / mint path routes through it; storage still uses the existing `get/setProviderConversationId` helpers (no new framework).
- L1–L4 below are then *behaviours of this owner*, not independent edits to scattered call-sites. This is the difference between the fix converging and the fix accreting.

### Layer 1 — Stop the bleed: cold-revive must not treat unknown exits as cold *(stopgap / defense-in-depth)*
- Change the revive decision so `isCold` is true **only with positive evidence**: `killedAt != null && Date.now() - killedAt > COLD_RESPAWN_MS`. When `killedAt == null` (unknown/abnormal exit) → **hot → resume**, never reset.
- Rationale: resume is non-destructive — if the conversation is genuinely gone it fails gracefully into the (now-narrowed, L4) overlay. Reset is destructive and must require evidence.
- Extract the decision into a pure function (mirror `pty-exit-strategy.ts`) for unit testing.
- **Preserves** the intended "idle >30min → fresh" behavior for the *known-killed* case (and L3 makes even that recoverable).

### Layer 2 — Stop minting phantoms: commit a conversation id only once Claude confirms it
- Client still mints the UUID and passes it to `pty.create` as `--session-id {id}` (needed for the CLI arg), **but no longer calls `onConversationCreated` eagerly** (`Terminal.tsx:952`).
- Source of truth for "a conversation exists" becomes Claude's **SessionStart hook** (already received in main — diagnostics show `pty.hook_received SessionStart` carrying the `session_id`). Persist `conversationId` in **main**, on SessionStart for the task's active session.
- Effect: a fresh session that dies before SessionStart commits **nothing** → the prior id (if any) is preserved, and no phantom is ever stored. Closes the phantom-creation path for *all* reset triggers (L1, manual Start-fresh, mode-switch, worktree change).

### Layer 3 — Durable self-heal: conversation-id history + on-resume disk fallback
- Add `conversationHistory: string[]` per mode in `provider_config` (append confirmed ids, dedup, cap N). Backfilled naturally as L2 confirms ids.
- Implement Claude transcript existence check (`detectSessionFromDisk` for `ClaudeAdapter`, using the encoded project-path dir + `<id>.jsonl`).
- On resume: if the stored id's transcript is absent on disk (or resume yields genuine SESSION_NOT_FOUND), **silently fall back to the most-recent history entry whose transcript still exists**, repoint, and resume it. Show the overlay only when *nothing* in history survives.
- Retention-independent (history lives in the main DB), future-proof, no migration needed for new cases.

### Layer 4 — Replace output-parsing detection with the structured signal (kill false positives, keep #90)
- **Make L3's structured disk/hook signal the authority for "is this session stale":** after a resume attempt, the truth is *does `<id>.jsonl` exist on disk / did SessionStart fire for this id* — not whether a phrase appeared in human-readable output. This is what false-trips today (the literal phrase lives in this repo → agent echoes it → mid-turn `'error'`).
- **Retire** the lifetime/whole-buffer regex paths (`pty-manager.ts:1570` ungated live scan, `:1781` whole-buffer exit scan) in favour of that signal. Keep a **narrow, startup-window-only** regex (gated on the now-live `checkingForSessionError`, declared `:139`/set `:1181`, currently dead) **only** as a fast-path hint, never as a lifetime authority — so genuine "No conversation found" is still caught instantly at resume without burying it in a shell (preserves #90).
- The gate (not node-pty event timing) decides → removes the data-vs-exit race entirely.
- **Must not** re-introduce the pre-#90 behavior (raw "No conversation found" buried in a recovery shell).

### Layer 5 — Telemetry (measure prevalence; validate the fix)
- Emit on overlay-shown: `{ mode, reason, storedIdEverPersisted }` (separates true expiry from never-written phantoms across the user base).
- Emit on revive-reset and on L3 self-heal recoveries.

### Layer 6 — Recovery + bounded best-effort migration
- **Immediate:** recover `dd45ad7a` → repoint to `b99e1b83` via the safe `slay tasks update` channel (writes + `/api/notify` → live app reloads; no raw SQLite write racing the WAL). Reversible (old id `1bb47f6c` recorded here).
- **One-time migration (on upgrade):** repoint a task only when **unambiguous** — stored id missing AND diagnostics holds a prior `--resume`d id that exists on disk. Logged, conservative, never guesses. Low yield (retention-bounded) but correct; L3 supersedes it for future cases.

---

## 6. Sequencing

- **PR1 — stop bleed + recover:** L1 + L6 recovery. (highest urgency, smallest; ships independently of L0)
- **PR2 — lifecycle owner + prevent:** L0 + L2 (L2 is the owner's first real behaviour).
- **PR3 — self-heal:** L3 (+ Claude transcript-on-disk check), as owner behaviour.
- **PR4 — detection:** L4 (retire regex authority in favour of L3 signal).
- **PR5 — telemetry:** L5 (can fold into PR1).
- Migration (L6 batch) after PR3.

L1 is deliberately ahead of L0 so the active data-loss path is closed without waiting on the refactor; L0 then absorbs it.

## 7. Testing (TDD — failing test first, per layer)

- **L1:** unit on the extracted revive decision — `killedAt=null` → resume (not reset); `killedAt` old → fresh. e2e: respawn-suggested after a non-host-kill exit → assert stored conv id unchanged.
- **L2:** integration — spawn fresh session, kill before SessionStart → assert task conv id **not** written; with SessionStart → assert written. Extend `e2e/git/94-session-invalidation.spec.ts`.
- **L3:** integration — stored id absent + surviving history entry → resume repoints silently, no overlay; all gone → overlay.
- **L4:** unit — phrase mid-session (outside startup window) does **not** set error; phrase during startup window does. Keep #90's genuine-stale case green.
- **L5:** assert events emitted with correct props.

## 8. Risks & rollback
- Layers are independent and small; no feature flag required. Manual "Start fresh" + overlay remain as the explicit user-driven recovery.
- L1: verify it doesn't suppress intended cold-fresh for genuinely idle tasks (covered by L3 recoverability).
- L4: regression risk = re-burying genuine stale errors; guarded by keeping startup-window detection and the #90 e2e.

---

## 9. Open questions
1. Does normal tab-close / app-quit route through the host-kill sentinel (`-2`)? Decides how often L1's `killedAt==null` path fires today.
2. History cap N — default 10?
3. Self-heal silent, or a "restored previous session" toast?
4. Ship the bounded L6 migration, or rely on L3 going forward only?
5. PR split as above, or one `terminal-convo-robustness` branch?
6. L2 commits the conv id ~1s after spawn (on SessionStart) instead of instantly — acceptable?
7. L0 scope — extend the existing in-memory session record as the lifecycle owner (lighter), or a dedicated module (cleaner boundary)?
