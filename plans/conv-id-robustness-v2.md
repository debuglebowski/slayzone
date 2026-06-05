# Plan: Kill false "session expired" — prevent phantoms + safe silent heal

**Supersedes** the analysis in `plans/conversation-id-robustness.md` (stale: claims L1/L2 pending — both partly shipped). This is the actionable plan for the agreed scope.

**Goal:** A 1-day-old healthy Claude task showed "session expired". Two outcomes:
- **(A) Prevent** — never store a conversation id that Claude hasn't actually persisted to disk.
- **(B) Heal** — a task already pointing at a missing (phantom) id silently reconnects to its real transcript, with **zero misattribution**.

**Locked decisions:** implement A+B together now · heal-on-open only (no mass sweep) · heal is **silent** (no toast) · work **directly on main**, no branch.

---

## 0. Verified current state (ground truth, this session)

- **Diagnosis confirmed** on task `2c350d03`: stored id `f30edf89…` has **no** `<id>.jsonl` on disk (phantom); real transcript is `7dddea2f…` (cwd `/Users/Kalle/dev/projects/slayzone`, branch `main`, first msg `21:23:29Z`, 69s after task birth, 7 user msgs). `updated_at` 06:57 today = clobber on this-morning reopen.
- **L1 shipped** (commit `cfdb25cd`): `decideReviveMode(killedAt,now)` — unknown kill → `resume`, never reset. Wired `TaskDetailPage.tsx:1280`. Test `revive-decision.test.ts` present.
- **L2 persist-half shipped**: `agent-hook.ts` `CONVERSATION_ID_CAPTURE_EVENT` includes `'claude-code':'SessionStart'`; `persistConversationId` (:312) writes the **real** hook `session_id` → `provider_config[mode].conversationId`. (Docstring :292 wrongly still says "codex, antigravity".)
- **Exit-path stale scan already gated** on `resuming` (`pty-manager.ts:1871`).
- **Remaining phantom source:** `Terminal.tsx:958` `onConversationCreatedRef.current?.(newConversationId)` — commits the freshly-minted UUID **before** Claude confirms. If that session dies pre-SessionStart (e.g. the `terminal_prewarm_enabled not pre-warmed` startup error seen in `7dddea2f`'s first line) → phantom persisted, never corrected.
- **Live-path false-overlay vector (separate):** `pty-manager.ts:1660` `adapter.detectError(data)` runs on **every** chunk, ungated → a mid-session echo of `No conversation found with session ID:` (the literal lives in this repo) flips the session to `'error'`.

---

## Part 1 — Prevention (stop minting phantoms)

**1.1 Remove the eager commit.** `Terminal.tsx` (~950–959): keep `newConversationId = crypto.randomUUID()` (still needed: it flows to `effectiveConversationId` :964 → `pty.create({conversationId})` :974 → `--session-id` arg). **Delete only** the `onConversationCreatedRef.current?.(newConversationId)` call (:958).
- Effect: conversation id is now persisted **only** by the SessionStart hook (real, confirmed). A fresh session dying before SessionStart persists **nothing** → prior id (if any) preserved, no phantom — for *every* mint/reset/mode-switch path.
- The `--session-id <minted>` is the same id SessionStart will report, so the success path is unchanged (persists once, deduped at `persistConversationId` :322).
- **TDD:** mount terminal in an AI mode → assert `onConversationCreated` is **not** called on create, and `pty.create` still receives a `conversationId`. Update any existing test asserting the old eager behaviour.

**1.2** Fix stale docstring in `agent-hook.ts persistConversationId` to include `claude-code`.

**1.3** L1 already done — just keep green.

---

## Part 2 — Heal (safe, silent, on reopen)

Two heal paths, ranked by certainty. **Core principle: never guess — any ambiguity → no heal → honest overlay** (false-negative OK, false-positive never).

**2.1 Per-task conversation history (exact path; covers all future tasks).**
- Extend `ProviderConfig[mode]` with `conversationHistory?: string[]`.
- Helper `appendProviderConversationId(cfg, mode, id)` — append if not already last, dedup, cap **N=10**.
- In `persistConversationId` (agent-hook.ts), when committing a confirmed id, also append to history. (These ids are *recorded as belonging to this task* → zero misattribution.)
- **TDD:** append / dedup / cap unit tests.

**2.2 Claude transcript-on-disk check.**
- Helper `claudeTranscriptExists(conversationId, cwd)` → `~/.claude/projects/<encoded(cwd)>/<id>.jsonl` exists? Encoding observed on disk: path → leading `-`, `/` and `.` → `-` (`/Users/Kalle/dev/projects/slayzone` → `-Users-Kalle-dev-projects-slayzone`).
- **TDD:** encoder unit test against the known mapping + edge chars.

**2.3 Pure heal resolver (the safety core — heavily tested).**
`decideConversationHeal(input) → { action: 'keep' | 'history' | 'orphan' | 'overlay', id? }`, inputs:
- stored id + whether its transcript exists,
- history entries + which exist on disk,
- candidate orphan transcripts `[{id, cwd, firstTs, gitBranch, referenced, nonEmpty}]`,
- task `{cwd, gitBranch, createdAt}`.

Rules (in order):
1. stored transcript **exists** → `keep` (never touch a healthy pointer).
2. else most-recent **history** entry whose transcript exists → `history`.
3. else filter orphans: `cwd === task.cwd` **&&** `!referenced` (by any task's conversationId/history/legacy col) **&&** `firstTs >= task.createdAt` **&&** (`gitBranch === task.gitBranch` || branch unknown) **&&** `nonEmpty`. Then:
   - **exactly one** survivor → `orphan`.
   - **zero or ≥2** → `overlay` (never pick a "best").
4. Orphan path gated to **legacy** tasks (`createdAt < FIX_SHIP_TS`); new tasks use history only (heuristic can never run on them).

- **TDD (must pass first):** healthy→keep · history present→history · exactly-one orphan→orphan · wrong cwd→overlay · two candidates→overlay · orphan referenced by another task→overlay · empty transcript→overlay · stored-exists-but-history-also→keep.

**2.4 Wire heal into the resume path (main).**
- Before turning a stored `conversationId` into `--resume`, run: build candidate list (read transcript dir for the cwd, parse each jsonl head for `{cwd, firstTs, gitBranch, nonEmpty}`, exclude ids referenced by any task), then `decideConversationHeal`.
- `heal` → `updateTask` repoint `provider_config[mode].conversationId` to healed id (+ append old phantom to history-as-evidence is NOT done; instead record old id in diagnostics), `notifyRenderer()`, then resume the healed id. **Silent.**
- `overlay` → unchanged current behaviour.

**2.5 Telemetry (fold in here).** Diagnostic events:
- `conv_id.heal { mode, via:'history'|'orphan', oldId, newId, evidence }` (reversible audit trail),
- `conv_id.heal_skipped { reason:'ambiguous'|'none', candidateCount }`,
- `overlay_shown { mode, storedIdEverPersisted }`.

---

## Part 3 — Narrow live false-positive detection (optional this batch)

`pty-manager.ts:1660`: gate the claude `SESSION_NOT_FOUND` **live** transition to the startup window (the already-declared `checkingForSessionError`, currently dead as a gate) so a mid-session echo of the phrase can't flip to `'error'`. Exit-path already gated — keep. Preserves #90 genuine-stale detection.

---

## Testing / verification

- **Unit:** revive (done) · history helper · path encoder · **heal resolver** (the big matrix above).
- **Integration/e2e:** extend `e2e/git/94-session-invalidation.spec.ts`: (a) phantom stored + one surviving orphan in cwd → silent repoint, **no** overlay; (b) phantom + two orphans → overlay (no heal); (c) phantom + none → overlay.
- **Manual:** reopen `2c350d03` on live dev app → silent heal to `7dddea2f` (covered by heal-on-open; no manual repoint needed).
- Gate: `pnpm typecheck` + `run-all.sh` + the 94-spec before each commit.

## Rollout (on main, per decision)

Commit in logical chunks, all this session: (1) prevention + docstring, (2) heal core (history + disk-check + resolver + tests), (3) heal wiring + telemetry, (4) Part 3 if included. TDD failing-test-first per chunk.

---

## Unresolved questions
1. History cap **N=10** ok?
2. Orphan heal **gated to pre-fix tasks** (new tasks → history only) — confirm?
3. Include **Part 3** (live-detection narrowing) in this batch or defer?
4. Heal records old phantom id in **diagnostics only** (reversible audit) — sufficient, or also keep it somewhere in the task?
