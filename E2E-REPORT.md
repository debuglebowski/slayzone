# E2E Test Report — 2026-04-04

## Overview

All 659 tests ran in 7.8 minutes. **657 passed, 0 failed, 2 skipped.** The suite is in excellent shape — no flakes, no failures, full green across all domains (smoke, CRUD, kanban, navigation, filters, settings, tags, tabs, terminals, git, browser views, CLI integrations, provider config, etc).

The only gaps are 2 intentionally skipped integration tests that require real CLI binaries (Gemini CLI, Codex CLI) installed on the machine.

## Results Summary

| Status | Count |
|--------|-------|
| Passed | 657 |
| Failed | 0 |
| Skipped | 2 |
| **Total** | **659** |

## Skipped Tests

| # | Test File | Test Name | Why Skipped | What It Would Take |
|---|-----------|-----------|-------------|-------------------|
| 1 | `97-session-id-consistency.spec.ts:55` | gemini: /stats detection saves a valid session ID | Entire `describe` block is `test.describe.skip` — requires real `gemini` CLI binary on PATH. Also has inner `test.skip(!hasGemini)` guard. | Install Gemini CLI, remove `.skip` from the describe block. Test itself is well-written (120s timeout, proper /stats parsing). Main risk: flaky due to real CLI boot latency in CI — may need a dedicated "integration" test tag and longer CI timeout. |
| 2 | `97-session-id-consistency.spec.ts:98` | codex: stored session ID not overwritten on fresh open | Same `test.describe.skip` block. Requires real `codex` CLI binary on PATH. Inner `test.skip(!hasCodex)` guard. | Install Codex CLI, remove `.skip`. Test pre-seeds a conversation ID and verifies it isn't overwritten on fresh open. Same CI concern — real CLI boot can be slow/flaky. Consider running these only in a nightly or manual pipeline with CLIs pre-installed. |

## Slow Tests (>10s)

| # | Test File | Test Name | Duration |
|---|-----------|-----------|----------|
| 1 | `48-cli-gemini.spec.ts:99` | detects working → attention state transition | 12.9s |
| 2 | `80-browser-view-google-login.spec.ts:29` | Google accepts browser after email submission | 11.4s |
