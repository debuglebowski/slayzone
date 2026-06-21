# Plan: Un-skip all e2e tests (92 remaining)

Goal: drive the 92 skipped e2e tests to zero by **shared-enabler clusters** (fix one
enabler → unblock many), ordered by ROI. Each test gets one verdict:
**fix** (real bug) · **migrate** (use-case exists, UI/model changed) · **remove**
(affordance genuinely deleted) · **keep** (correct conditional skip).

Done-this-session baseline: red (4) + orange (~9) + aiConfigOps init **bug fixed**
+ file 62 (3 migrated, 2 removed). Helpers built: `gotoContextSection`,
`openUserContextManager`/`openProjectContextManager` (tab-store driven).

---

## Phase 0 — Foundations (do first; protects the machine + unblocks Phase 1)

1. **Sandbox `HOME` for computer-files tests.** Today the CM "computer files" tests
   write to the **real `~/.claude/skills/`** (and `~/.codex/` …) and only clean up on
   success — failed runs litter the user's real config. Point these at a temp HOME
   (env override in the electron fixture, scoped to the specs that touch computer
   files) before doing more CM work. *(infra; no test count, but a correctness/safety
   prerequisite.)*
2. **Add a `workers:1` serial Playwright project** for specs that only fail under
   parallel GPU/CLI contention. Enables Phase 1 with zero test rewrites.

## Phase 1 — Serial-lane reclaim — ~14 tests, **cheapest/highest ROI**
Pure env/parallel flake (not obsolete): `81`(5 MV3 ext), `49`(4 opencode), `47`(3
cursor), `76`(1 zorder), `79`(1 events). **Verdict: migrate via config** — move to the
serial lane + un-skip, no body changes. Validate each passes at `workers:1`.
NOTE: `48`(4 gemini) is **removed**, not serial-laned (decision: drop gemini tests).

## Phase 2 — Sidecar `pty:create` capture — 16 tests, one enabler
`93`(12 resume opts) + `94`(4 session-invalidation) fail because they spy on the
**host** `ipcMain.handle('pty:create')`, orphaned by the slice-9 sidecar cutover.
**Enabler:** a PLAYWRIGHT-gated hook that records the opts the renderer sends over
tRPC to the side-car (or a side-car capture buffer queryable from the test). One
piece → all 16. **Verdict: migrate.**

## Phase 3 — Context-manager — 24 tests (`63`=22 + `62`'s 311/350)
The instructions/skills **model** was redesigned to variant-based
(`getRootInstructions().content` = linked library variant, not `saveInstructionsContent`).
**Enabler:** a small set of data-layer helpers for the variant flow (`createItem`
root_instructions/library → `setProjectInstructionVariant` → `saveLibraryInstructions`)
plus the existing push/pull procs (already verified working). Rewrite the sync/stale/
roundtrip tests to drive the full stack via the renderer tRPC client + filesystem
asserts (precedent: `451`). **Verdict: mostly migrate; remove any confirmed-dead
affordance (e.g. obsolete help/affordance) after checking.** 311 (MCP add-server flow)
+ 350 (library-link, needs its `upsertLibrarySkill` helper migrated) finish 62.
Redesign is confirmed **done** — no timing caveat; can run any time.

## Phase 4 — Web-panel / webview — 13 tests
`61`(4) + `71`(9): web panels migrated `<webview>` → WebContentsView. **Enabler:**
fix the test-side WCV view-registration + rewrite `getWebPanelUrl`-style helpers to
query WCV views (listViews) instead of dead `<webview>` DOM. **Verdict: migrate the
panel-handoff/URL behavior; REMOVE the `<webview>`-specific `window.open` tests
(~3–4) whose mechanism no longer exists.** These describes are `serial`/stateful —
fix the whole describe, not piecemeal.

## Phase 5 — Scattered singles — ~13 tests
Per-test triage: `33`(3 git-merge full-suite ordering → isolate/fix), `46`(3 web-panel
settings UI → migrate), `55`-crash(4) + `55`-shell(1) (custom-mode initialCommand
contract → migrate or fix), `27`/`30`/`37`/`83`/`87` (terminal CLI-spawn/lock →
migrate or env), `98` codex-resize-gray-area (documented CDP harness limit, cosmetic →
likely **remove**).

## Phase 6 — Conditional `97` (4) + gemini removal
Decision: **remove all gemini e2e tests** — `48-cli-gemini` (4, Phase 1 above) and the
gemini-conditional cases in `97-session-id-consistency` and any gemini branch in
`37-codex-status-retry`. Codex stays (migrate / keep conditional). Net: gemini coverage
intentionally dropped.

---

## Execution discipline (every phase)
- One cluster at a time; commit per logical unit; suite stays green (never leave red).
- Confirm-before-remove: verify the affordance/feature is actually gone (as done for
  62's help-cards) — never delete a test whose use-case still ships.
- Run targeted (`-g`/file) at `workers:1`; verify `~/.claude` stays clean each run.
- Re-run the `--list --reporter=json` skip-count after each phase to track burn-down.

## Rough sizing (ordered by ROI)
| Phase | Tests | Effort |
|---|--:|---|
| 1 serial-lane | ~18 | S (config) |
| 2 pty:create capture | 16 | M (one enabler) |
| 4 web-panel WCV | 13 | M |
| 5 scattered | ~13 | M (per-test) |
| 3 context-manager | 24 | L (model rewrites) |
| 6 conditional | 4 | XS (decision) |

Suggested order: **0 → 1 → 2 → 4 → 5 → 3 → 6** (front-load cheap/high-leverage; 63 last
since it's largest and may still be moving).

## Decisions (resolved)
1. CM redesign is **done** → Phase 3 can run any time.
3. **Remove all gemini tests** (don't install/keep).
5. Redesign-dropped affordances → **remove** the test (don't re-point to new UI).

2. **Yes** — serial-lane approved (small CLI/heavy group runs one-at-a-time).
4. **Move faster** — lower removal bar: delete on strong signal (fails + selectors/
   feature clearly gone) without belaboring each; still use judgment, skip the deep
   per-test confirm.
