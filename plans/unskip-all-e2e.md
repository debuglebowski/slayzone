# Plan: Un-skip all e2e tests → zero skips — ✅ DONE 2026-07-07

Goal reached: **zero statically skipped e2e tests.** Verified: batch run of all 15
touched files = **131 passed (2.2m)**; each file also green ≥2× isolated.

Remaining `test.skip(...)` markers are all correct runtime env-guards (kept by design):
- `97-session-id-consistency` ×2: `test.skip(!hasCodex, 'codex not on PATH')`
- `81-browser-extension-usage`: `test.skip(!extPath, '1Password extension not found…')`

## Outcome by cluster (2026-07-02 → 2026-07-07)

- **CM redesign — 63 (17 green, 5 removed w/ in-file justification) + 62 (5 green).**
  Fixture root cause: Project→Skills sidebar button grows a stale-count dot that
  changes its accessible name; exact-name match silently landed on Library→Skills.
  Fixed in `e2e/fixtures/context-manager.ts` (nav scoped by level order + arrival
  heading check).
- **pty-capture — 94 (4) + 93 (10) green.** Migrated 94 to sidecar-side capture
  (`testSetPtyCreateCapture`); added PLAYWRIGHT-gated `testTakePtyKillCalls` +
  `testEmitExit` hooks; `closeAllTaskTabs` afterEach teardown ends serial
  contamination. REAL BUG fixed: `getModeLabel()` missing `'qwen-code'` case.
- **61 handoff (4 green).** WCV panels never load a document until forced —
  `executeJavaScript` on document-less frame hangs forever. Helpers now force a
  real `about:blank` load; `void window.open(...)` avoids WindowProxy serialization.
- **71 popups (17 green ×3).** Both web-panel describes migrated to WCV; one
  expectation inverted to current design (panels ALLOW featured popups for OAuth).
- **81 extensions (5 green).** "Electron env limit" diagnosis was WRONG: fixture
  path drift from the e2e/→e2e/browser/ move — extensions never loaded. Path fix
  revived all 4 "impossible" tests.
- **46 panels (29 green).** Fresh custom panel = task-scope enabled by default
  (missing `viewEnabled` entry = enabled); home-scope is a disabled placeholder
  for web panels. Cmd+L passed as-is.
- **terminal — 30 (7), 55-crash (7), 55-shell (1) green.** No source hook needed:
  `terminal_auto_start='1'` seeding beats the post-remount idle gate;
  `shouldShellFallback` works (banner only missed because spawn was gated).
- **76 zorder (8 green).** Assertion migrated to the real contract: inactive task's
  view KEEPS PAINTING, parked at (-20000,-20000) (`useBrowserViewBounds` offScreen)
  — it does not flip visible=false. Fixture `openTaskViaSearch` gained press→appear
  retry (mod+k swallowed right after task switch until shortcut-active propagates).
- **87 agent-lock (5 green).** REAL cause: `slz-file://` guard rejects file:// paths
  outside $HOME — fixtures in os.tmpdir() served "Access denied" stub with no #b.
  Fixtures now under `~/.slayzone-e2e-tmp` (cleaned in afterAll).
- **33 merge-UI (10 green).** `ensureGitPanelVisible` toggle-race: a landed Meta+g
  + slow mount + blind re-press toggled the panel back off. Now one-way opens via
  the header "Git" PanelToggle button with a 3s mount wait per attempt.

## Removed tests (all with in-file `// REMOVED <date>` justification)
- 63: 5 tests asserting redesign-dropped affordances (per-provider push button,
  stale-card pull ×2, roundtrip, manage-from-row).
- 47-cursor-cli file (2026-06-24): cursor-agent produces zero output in-harness.
- 62 (2026-06-20, prior): library-skill help card, section-level pinned help card.

## App-code changes made along the way (all uncommitted with the spec work)
- `get-tab-label.ts`: `case 'qwen-code': return 'Qwen'` (user-facing label fix).
- PLAYWRIGHT-gated test hooks: pty-manager kill-capture (+pty-store op),
  transport pty router `testTakePtyKillCalls` / `testEmitExit`.
- (Pre-existing in tree: `skill-row-*` testid in SkillListView.tsx,
  `savePanelConfig` mergePanelOrder fix.)
