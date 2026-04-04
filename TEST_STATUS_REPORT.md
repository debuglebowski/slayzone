# Test Status Report

Generated: 2026-04-03

## Summary

This repo uses a mixed test stack:

- `vitest` for most unit tests
- ad hoc `tsx` script tests for many pure logic tests
- Electron-backed script tests for DB/IPC/integration coverage
- Playwright for end-to-end coverage

### Executed assertion/spec counts

| Runner | Passed | Failed | Skipped | Notes |
| --- | ---: | ---: | ---: | --- |
| Vitest | 146 | 4 | 0 | Real assertion failures only |
| Node custom script tests (`node --import tsx`) | 595 | 0 | 0 | 31/32 entrypoints passed |
| Playwright e2e | 0 | 128 | 540 | Every failed spec reports `Process failed to launch!` |
| **Total executed** | **741** | **132** | **540** |  |

### Crashed test entrypoints that did not report internal assertion counts

| Bucket | Count | Status |
| --- | ---: | --- |
| Electron-backed custom test entrypoints | 34 | All crashed before reporting assertion counts |
| Node custom entrypoints | 1 | Crashed before reporting assertion counts |

The practical read is:

- The pure unit/logic layer is mostly green.
- There are 4 real Vitest assertion regressions.
- Electron-backed integration tests are broadly blocked by an import/runtime issue.
- The entire Playwright suite is blocked at app launch.

## Real Assertion Failures

### 1. `packages/domains/automations/src/client/AutomationCard.test.tsx`

- Failing test: `renders a structured summary with status and configuration metadata`
- Failure purpose: the test still expects text like `Active`, `Task status`, `Run command`, and `3 runs`, but [`packages/domains/automations/src/client/AutomationCard.tsx`](/Users/Kalle/dev/projects/slayzone/packages/domains/automations/src/client/AutomationCard.tsx) now renders a much leaner collapsed card and only shows run/status details when expanded.
- Likely fix: update the test to match the current collapsed UI, or restore the removed summary fields if the old behavior was intentional.
- Fix difficulty: `Easy`

### 2. `packages/domains/task/src/client/TaskSettingsPanel.test.tsx`

- Failing tests:
  - `switches to history and back from the header action`
  - `resets to default view when the task changes`
  - `keeps the header action on the right and updates its copy by view`
- Failure purpose: the test expects `View history`, but [`packages/domains/task/src/client/TaskSettingsPanel.tsx`](/Users/Kalle/dev/projects/slayzone/packages/domains/task/src/client/TaskSettingsPanel.tsx) now renders `View activity`.
- Likely fix: rename the test expectations from `View history` to `View activity`, unless the component text change was accidental.
- Fix difficulty: `Easy`

## EntryPoint Crashes

### 1. Electron-backed custom tests: 34 crashed entrypoints

Most of the Electron-backed script tests fail before running assertions.

Primary failure:

- 33 entrypoints crash with `Error [ERR_REQUIRE_CYCLE_MODULE]: Cannot require() ES Module ... @dagrejs/dagre/dist/dagre.esm.js in a cycle`
- Affected areas include:
  - app DB migration tests under `packages/apps/app/src/main/db/*.test.ts`
  - CLI integration tests under `packages/apps/cli/test/*.test.ts`
  - many domain handler/integration tests under `packages/domains/*/src/main/*.test.ts`
  - AI config main handler tests under `packages/domains/ai-config/src/main/*.test.ts`

Failure purpose:

- A runtime import path now pulls `@dagrejs/dagre` into Electron’s Node-mode test runtime, and that import graph is cycling badly enough that Electron aborts before test execution.

Likely fix:

- isolate graph-layout / dagre usage so it is only loaded in client/UI code
- make the dagre import lazy or move it behind a boundary that main-process and test-harness code do not load
- then rerun the Electron-backed integration tests

Fix difficulty: `Medium-High`

Secondary failure:

- `packages/domains/task/src/main/handlers.test.ts` crashes with `await can only be used inside an async function` at line 579

Failure purpose:

- the test file contains `const h2 = await createTestHarness()` inside a non-async `describe(...)` callback, so the file does not transform correctly.

Likely fix:

- move that setup to top level or make the surrounding structure valid for async initialization

Fix difficulty: `Easy`

### 2. Node custom entrypoint crash: 1 crashed entrypoint

File:

- `packages/domains/worktrees/src/main/remove-worktree.test.ts`

Failure purpose:

- the test creates a temporary git repo and runs `git commit -m "initial"`, but the environment’s git setup tries to talk to 1Password and fails with:
  - `error: 1Password: Could not connect to socket. Is the agent running?`
  - `fatal: failed to write commit object`

Likely fix:

- disable signing and external git credential/signing helpers inside the temp repo created by the test
- or override the relevant git config/env vars inside the test before committing

Fix difficulty: `Medium`

## Playwright E2E Status

### Result

- Passed: `0`
- Failed: `128`
- Skipped: `540`

### Failure purpose

Every failed Playwright spec reports the same top-level error:

- `Error: Process failed to launch!`

This is not a scattered UI failure pattern. The app is failing before the individual scenarios can run, so the 540 skipped specs are mostly cascade fallout after launch failure.

### Likely fix

- debug the Electron process launch path first
- inspect startup stderr / launch arguments / preload-main startup regressions
- verify whether this is a repo regression or a sandbox/environment sensitivity specific to headless Playwright launch

Fix difficulty: `High`

## Recommended Fix Order

1. Fix the 4 stale Vitest expectations first. Those are cheap and unblock a clean unit baseline quickly.
2. Fix the Electron `@dagrejs/dagre` import-cycle problem next. That is the biggest blocker because it hides the real status of 34 integration entrypoints.
3. Fix `packages/domains/task/src/main/handlers.test.ts` async setup error.
4. Fix `packages/domains/worktrees/src/main/remove-worktree.test.ts` so it does not depend on local 1Password/git signing state.
5. Only then chase the Playwright launch failure, because right now the app is not getting to scenario execution at all.

## Raw Artifacts

Raw logs and machine-readable results were written under:

- `/tmp/slayzone-test-results`
