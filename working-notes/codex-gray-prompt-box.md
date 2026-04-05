# Codex Gray Prompt Box — Investigation

## The Issue

Codex CLI (v0.118.0) renders a gray background (`#303033` / `48;2;48;48;51`) on its prompt input line when running in a real terminal or in SlayZone's dev mode. This gray box does NOT appear when running under Playwright e2e tests.

The test at `packages/apps/app/e2e/terminal/98-codex-resize-gray-area.spec.ts` needs this gray box to be visible to test the resize artifact.

## Root Cause

Codex uses crossterm's `terminal-colorsaurus` crate to detect terminal capabilities at startup. It sends DA1, OSC 10, OSC 11, CPR, and DSR queries and requires ALL responses to arrive within a timeout (~100-500ms). Based on the responses, it decides whether to render the gray prompt background.

SlayZone's `interceptSyncQueries` in `packages/domains/terminal/src/main/pty-manager.ts:205` correctly intercepts these queries and responds via `writeSync(fd)` in **0.01ms**. The function itself is not the bottleneck.

The bottleneck is **when `onData` fires**. In Electron, node-pty's data events go through libuv → Chromium message loop → JavaScript callback. Playwright's debugging connection (CDP pipe) adds constant event loop activity (renderer events, IPC, internal keepalives) that delays libuv's PTY fd polling. By the time `onData` fires and `interceptSyncQueries` responds, crossterm has already timed out.

## Proof

| Environment | Gray box | Why |
|---|---|---|
| System Node.js + node-pty | ✅ | No Chromium overhead |
| `ELECTRON_RUN_AS_NODE=1` + node-pty | ✅ | Electron's Node but no Chromium |
| Manual Electron app (no Playwright) | ✅ | No CDP debugging connection |
| Manual Electron app + `PLAYWRIGHT=1` env | ✅ | Env var alone doesn't matter |
| Playwright-controlled Electron app | ❌ | CDP connection delays event loop |

Standalone node-pty test that reproduces the gray box:
```javascript
const pty = require('node-pty');
const proc = pty.spawn('codex', ['--full-auto', '--search'], {
  name: 'xterm-256color', cols: 100, rows: 40,
  env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', COLORFGBG: '15;0' }
});
proc.onData(data => {
  if (data.includes('\x1b[c'))   proc.write('\x1b[?62;4;22c');  // DA1
  if (data.includes('\x1b[5n'))  proc.write('\x1b[0n');          // DSR
  if (data.includes('\x1b[6n'))  proc.write('\x1b[1;1R');        // CPR
  if (data.includes('\x1b]10;?')) proc.write('\x1b]10;rgb:d4d4/d4d4/d8d8\x07'); // OSC 10
  if (data.includes('\x1b]11;?')) proc.write('\x1b]11;rgb:1414/1414/1818\x07'); // OSC 11
});
```

Removing ANY single query response causes the gray box to disappear — all five are required.

## What We Tried (test-side)

All of these failed to produce the gray box under Playwright:

- **Show window early** — `win.show()` in beforeAll before terminal init
- **Pre-seed terminal theme** — `pty:set-theme` IPC before task open
- **Pre-trust project** — write to `~/.codex/config.toml` before test
- **JIT warmup** — create throwaway terminal to warm up `interceptSyncQueries`
- **Silence after task open** — `waitForTimeout(5000)` after clicking task
- **Raw setTimeout** — `new Promise(r => setTimeout(r, 5000))` to avoid Playwright CDP
- **Remove assertions** — no `expect.poll` between task open and silence
- **Early response block** — respond at top of `onData` before other processing
- **`pty.write()` instead of `writeSync(fd)`** — async write
- **Optional terminator matching** — match OSC queries without BEL/ST
- **Pre-create PTY** — create PTY via IPC before opening task UI
- **Worker thread fd watcher** — read/write on master fd from worker (failed: competing readers)
- **Pre-write responses** — write before Codex queries (consumed by shell)
- **Various env vars** — `TERM_PROGRAM=iTerm.app`, `VTE_VERSION`, etc.

## The Fix

The response must happen **outside JavaScript's event loop** — at the native (C++) level on the PTY master fd. Options:

1. **Native addon**: C++ addon that watches the PTY master fd via `kqueue`/`epoll` and responds to DA1/OSC/CPR/DSR queries inline, before the data reaches node-pty's JavaScript layer. This is the proper fix.

2. **Patch node-pty**: Fork node-pty to add query interception in its C++ read loop. Responses are written before the JavaScript callback fires.

3. **Accept the limitation**: The gray box is cosmetic. The resize test can still verify the `scrollOnEraseInDisplay` + SIGWINCH race condition behavior by checking viewport text content rather than visual styling.

## Secondary Issue: Model Change Prompt

Codex occasionally prompts to change models (e.g. `gpt-5.3-codex → gpt-5.4` migration from `~/.codex/config.toml` `[notice.model_migrations]`). The test's trust/prompt handler at line ~97 now also matches `model`+`keep`/`change` and presses Enter.

## Key Files

- `packages/domains/terminal/src/main/pty-manager.ts:205` — `interceptSyncQueries`
- `packages/domains/terminal/src/main/pty-manager.ts:250` — `writeSync(fd)` response
- `packages/domains/terminal/src/main/pty-manager.ts:181` — `currentTerminalTheme` default
- `packages/apps/app/e2e/terminal/98-codex-resize-gray-area.spec.ts` — the test
- `packages/apps/app/e2e/fixtures/terminal.ts` — terminal test helpers
- `~/.codex/config.toml` — Codex trust levels and model migrations

## Current State

- `pty-manager.ts` — **clean** (all diagnostics reverted)
- Test file — **cleaned up** with known limitation documented in header comment, model prompt handling added
- The test passes (Codex TUI renders, resize works) but without the gray prompt background
