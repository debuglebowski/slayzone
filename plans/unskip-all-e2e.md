# Plan: Un-skip all e2e tests → zero skips

Goal: zero skipped e2e tests. **Verdict per test: fix (real bug) · migrate (spec
drift) · remove (dead/impossible) · keep (correct conditional).**

## 2026-06-23 GROUND-TRUTH re-baseline (verified by running, not guessing)
All skip markers flipped → ran the affected 21 files. Result: **62 passed / 53 failed**.
Many stale 2026-05-16 `describe.skip` quarantines now PASS for free. Tree currently
has ALL skips flipped (WIP, uncommitted). Inner `test.skip(!hasCodex)` env-guards KEPT.

### STALE-GREEN (now pass — keep unskipped, FREE WINS)
- `83` cursor-stability (1/1) ✓ full file green
- `33` 'Git init' describe ✓ (only `33:226` merge-UI fails)
- `93:161` cursor resume ✓ (skip reason "slow CLI" was wrong — capture is stubbed)
- `71` 15/17 ✓ (only `562`,`719` fail)
- `61` 3/4 ✓ (only `219` fails)
- `55-crash` 6/7 ✓ (only `102` fails)
- `81` 1/5 ✓ (4 fail)
- `30:300` clear-buffer ✓ (batch fail was contention flake — passes isolated)

### REAL WORK (53 fails, by cluster, ROI order)
**CM redesign — 24 (BIG): `63`(22) + `62`(2)** — Phase-3 variant model. `instructions-textarea`
testid GONE from components; test helper `openInstructionsDialog` still hunts the old
`'Project Settings'` dialog (CM is now a full-screen 'Context Manager' view). All 22 fail
at first element. ENABLER: rewrite the in-spec open/nav helpers to the new CM view +
current testids. One helper fix likely revives most. → migrate.

**pty-capture lifecycle — 6: `94`(4) + `93:190`,`93:219`**
- `94` all 4: `toBeGreaterThan(0)` → capture count 0; needs the 93-style createPty
  capture wiring (`testSetPtyCreateCapture`/`testTakePtyCreateOpts` + idle-gate). → migrate.
- `93:190`(opencode) `93:219`(qwen): `getLastOpts` null even isolated. Suspect serial
  contamination from newly-unskipped `93:161` cursor (shared capture). → fix ordering/teardown.

**real-CLI idle-gate — 5: `97`(2 codex) + `47`(3 cursor)**
- `97:48`,`97:89`: codex on PATH but `openTaskTerminal` no longer auto-spawns (idle-gated)
  → add `startAgentTerminal`. → migrate.
- `47` cursor ×3: real cursor CLI no output (timeout). Add `startAgentTerminal`; if still
  flaky = inherent CLI-in-e2e slowness → guard (hasCursor) or remove. → migrate/remove.

**WCV / web-panel migration — 5: `61:219`,`71:562`,`71:719`,`76:198`,`79:92`**
- `61:219`: `getWebPanelUrl` returns `'no-webview'` (webview→WCV). Rewrite helper to WCV. → migrate.
- `71:562`,`719`: window.open BrowserWindow assertions (`toMatch`). → migrate (or remove dead window.open path).
- `76:198`: inactive views offscreen — WCV reposition timing. → fix wait.
- `79:92`: dom-ready JS exec `toContain`. → fix wait/executeJs.

**terminal singles — 6**
- `37:180`: remove gemini branch (Phase-6 resolved), keep codex/cursor/terminal/claude. → migrate.
- `30:159`: mode-switch teardown needs source hook (markSkipCache/remountTerminal). → fix/migrate.
- `55-crash:102`: crash overlay appears. → fix/migrate.
- `55-shell:65`: interactive shell after CLI non-zero (custom-mode initialCommand). → migrate.
- `98:135`: codex resize gray-area — documented CDP harness limit, cosmetic. → remove.
- `87:180`: agent CLI ops while locked — `#b` click element. → fix fixture/route.

**panels — `46`: FIX LANDED (`287` green), 2 deferred**
- ROOT (fixed): `savePanelConfig` didn't keep `order` complete → added panel unrendered
  until broadcast. FIX: `usePanelSettings.savePanelConfig` wraps `mergePanelOrder` (app-code).
  Verified: delete-custom (`287`) now passes; card renders.
- DEFER `46:168` (new panel's switch defaults unchecked + row now has 2 switches home/task —
  pick correct default-enabled scope) and `46:227` (Cmd+L → web-panel-toggle routing).

**Round-2 reverts (serial-coupling / batch-flake — defer WHOLE describe, can't cherry-pick):**
- `55-crash` 'Terminal crash overlay': later tests depend on the crash trigger (102, flaky).
- `71` both window.open describes: real-BrowserWindow timing flakes under batch load.
- `93` 'Resume command opts': reverted to main (161 stays skipped — unskipping adds a 6th
  sequential AI-mode open that destabilizes the shared createPty capture; fix needs
  per-test terminal teardown, same enabler as `94`).

**extensions env-limit — 4: `81:64/117/149/181`** (`181` tagged `@known-limitation`)
MV3 service-worker / extension host unreliable in e2e Electron (GPU contention, documented).
→ investigate; if truly impossible, remove (feature works in-app; not an app bug).

**opencode idle — 1: `49:120`** — Bubble Tea TUI idle pattern doesn't match in time;
commit 6a6d1838 deliberately kept-skip; spawn+I/O covered by 3 passing tests. → remove (for zero).

## Execution discipline
- Spec-only edits → NO rebuild. App-code fixes → batch → one `pnpm build` → verify.
- `--reporter=line` (survives kill). Run targeted, isolated per file (avoid contention flakes).
- Suite stays green per commit; never commit red. Commit per cluster (await approval).
- Run: `env -u ELECTRON_RUN_AS_NODE npx playwright test --config playwright.config.ts <files>`

## Decisions (resolved)
- Remove all gemini tests/branches. Remove redesign-dropped affordances. Lower removal bar.
- Keep inner `test.skip(!hasCodex)` env-guards (idiomatic).
