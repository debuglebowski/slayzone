# E2E: rebalance the parallel groups so no group sets the wall clock

**Status: measured, designed, NOT yet applied — blocked on a live collision (§5).**

## 1. No new measurement run is needed

The sibling campaign task (`04864612`) has already banked **14 full-suite runs** with
per-group Playwright JSON under `~/.slayzone-e2e-campaign/`. Per-spec durations extract
from those directly. Phase 1 of the original plan — build + a baseline run for timings —
is **cancelled**: the data exists, and taking box time for it would collide with the
campaign for no gain.

Aggregator: `scratchpad/spec-times.mjs` (median per spec across runs).

## 2. Finding: one spec is 55% of the `terminal` group

`terminal/101-shared-atlas-sibling-repair.spec.ts` = **102.9s median**, out of 187s of
test-time across all 39 terminal specs. The next-heaviest is 9.6s.

**No subject split of `terminal` can balance while that file sits in a half.** Isolating
it is not a workaround — the atlas specs are a real subsystem (shared WebGL texture
atlas), so they get their own group and the balance falls out for free.

## 3. Finding: group time is NOT dominated by test execution

| Group | Specs | test-time | wall (aged host) |
|---|---|---|---|
| core | 53 | 194s | 384–414s |
| terminal | 39 | 187s | 294–342s |
| browser | 22 | 126s | 228–264s |
| git | 19 | 91s | 204–252s |
| runners | 2 | 99s | 102–138s |

Fitting `wall = boot + f·specs + test-time` over core/git gives **boot ≈ 89s**,
**per-spec-file overhead ≈ 1.9s** (`beforeAll`/`resetApp`, uncounted in test duration).
It holds directionally but not tightly across groups — the early-finishing groups ran
under heavier contention, so absolute prediction from this data is not credible.

Two consequences:
- Splitting a group **duplicates ~89s of boot** into the pool. Every split has a floor.
- File-count overhead is *preserved*, only redistributed. Splitting does not halve a group.

So the partition is driven by **weight = test-time + 2s × file-count**, and the outcome
is verified by measurement rather than predicted.

Also checked: **0 skipped tests** in core and terminal (381 + 114 tests). The sub-second
spec files are genuinely fast, not dead.

## 4. Caveat on the brief's numbers

The brief's table (core 5.1m, wall 5.4m) and the campaign's runs (core 6.4–6.9m, wall
7.1–7.7m) are different commits *and* different host conditions — the campaign labels
literally read `aged`/`aged3`. **Relative spec weights are stable across both; absolute
seconds are not.** Before/after must be measured on the same host state, back to back.

## 5. BLOCKER — live collision with the campaign task

`04864612` is `in_progress` and has **uncommitted work in the exact files this touches**:

```
 M packages/apps/app/e2e-parallel.sh                      (+59/-24 — the file the guard goes in)
 M packages/apps/app/e2e/core/100-server-settings-toggle.spec.ts   ← a file this moves
 M packages/apps/app/e2e/core/52-kanban-keyboard.spec.ts           ← a file this moves
?? e2e-campaign.sh  e2e-aggregate.mjs  e2e-covariates.sh  e2e-isolate.sh
```

Those two specs are two of the "5 unknowns" that task is mid-classification on.

**Good news, verified:** the campaign's new scripts contain **no hardcoded group names** —
they discover groups from `e2e/*/` generically. Renaming and splitting groups will not
break their tooling, and `E2E_RUN_DIR` (their JSON-report plumbing, already landed in
`e2e-parallel.sh`) is exactly the hook the guard needs. **I will build on theirs rather
than add a duplicate `E2E_JSON_REPORT_DIR`.**

Remaining conflict is ordering, not design: `git mv` preserves working-tree content, so
their spec edits survive the move — but their agent holds the *old* paths and would
recreate stale copies on its next write.

## 6. The partition (final, from measured weights)

`core` → **`core`** + **`platform`**; `terminal` → **`terminal`** + **`atlas`**.

**`core`** (31 files, 108.2s) — app shell, projects, tasks, board, tabs, nav, filters, tags, tree view:
`01-smoke 02-onboarding 03-projects 04-tasks-crud 05-kanban 06-task-detail 07-navigation
08-filters 10-edge-cases 11-create-task-dialog 12-tags 13-filters-advanced
14-project-settings 15-task-detail-actions 16-tab-management 17-multi-project
18-kanban-interactions 21-error-states 52-kanban-keyboard 57-cmd-w-close 66-tab-store
67-home-panel-persistence 69-list-view-empty-drop 90-tag-edit-dialog
92-tag-responsive-overflow 93-kanban-scrollbars 95-task-progress 96-tree-view-filters
97-tree-view-dnd 98-tree-view-multi-select 99-tree-view-actions`

**`platform`** (22 files, 86.0s) — settings surfaces, panels, files, artifacts, automations, server/sidecar/remote/runner, auth, export:
`09-settings 19-panel-toggles 25-panel-resize 44-file-editor 45-file-tree-rename
53-export-import 64-execution-context 65-leaderboard-auth 72-custom-shortcuts
91-chat-queue 91-cli-automation-trigger 93-artifacts-panel 94-artifact-html-preview
94-settings-cards-sizing 95-automation-catchup 100-server-settings-toggle
101-remote-probe 102-runner-settings-tab 102-sidecar-crash-recovery
103-remote-config-screen 104-server-restart 105-artifact-downloads`

**`atlas`** (3 files, 107.5s) — shared WebGL texture atlas:
`99-webgl-diag-verify 100-task-switch-atlas-stability 101-shared-atlas-sibling-repair`

**`terminal`** (36 files, 79.8s) — pty lifecycle, buffer, tabs, search, split, agent hooks, sessions.

### Projected balance (weight = test + 2s×files)

| Group | Files | Weight |
|---|---|---|
| core | 31 | 170 |
| browser | 22 | 170 |
| terminal | 36 | 152 |
| platform | 22 | 130 |
| git | 19 | 129 |
| atlas | 3 | 113 |
| runners | 2 | 103 |

Median 130, threshold 195, max 170 → **guard passes with margin**. Critical-path weight
drops **300 → 170 (−43%)**. Applying the fitted marginal rate to the aged-host baseline
puts wall clock near **~5m vs 7.1–7.7m**; on a fresh host the equivalent is ~4.3m vs
5.4m. Both are projections — §3 says treat them as direction, not promise.

`browser` (weight 170) ties `core` as the new ceiling. Splitting it too would buy ~3s of
wall clock and cost another 89s of boot — **not worth it. Stop at 7 groups.**

## 7. Remaining steps

1. Resolve §5 ordering with the campaign task.
2. `git mv` per §6. No import rewrites — every spec imports only `../fixtures/*`, which
   is depth-invariant across a sibling-directory move (verified: 188 import sites).
3. N=3 runs, green, wall clock recorded against a same-session baseline.
4. Balance guard in `e2e-parallel.sh`: real per-group elapsed (bash `SECONDS`, not
   scraped from Playwright output), median, fail if max > 1.5×. `perf` excluded (serial).
5. `pnpm lint:e2e-guardrails` green; no new `pnpm lint` violations.

Any order dependency the split exposes gets **reported as a finding**, not hidden by
restoring the old grouping.

## Unresolved questions

1. Campaign task holds `e2e-parallel.sh` + 2 specs uncommitted, and needs the box.
   Land this after its current run, or have it pause? **Only real blocker.**
2. Names `core` / `platform` / `terminal` / `atlas` OK?
3. Guard breach = exit 1, or warn-only for the first few runs?
