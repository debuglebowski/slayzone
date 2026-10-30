# fake-codex: a scripted `codex app-server` for chat tests

`fake-codex.mjs` stands in for `codex app-server`, the JSON-RPC-over-stdio server
SlayZone's Codex chat (`codex-chat`) spawns (`packages/domains/terminal/src/server/agents/codex/`).
It plays a **scenario** (what to send, when, and how to react to what the app
sends) and **records** everything it receives. No network, no account, no build
step (plain ESM, Node builtins only). The Codex twin of `../fake-claude`; both
sit on the shared core in `../fake-cli` (wrapper, epochs, logs, transcripts).

| File | What |
|---|---|
| `fake-codex.mjs` | The server. |
| `scenario.ts` | Scenario types, the `cx` notification builders, the `cstep` step builders, `codexReply` / `streamReply` / `commandTurn` / `codexEchoTurn`. |
| `index.ts` | `createFakeCodex()` plus readers for each spawn's log (`FakeCodexEpoch`, `FakeCodexRun`). |
| `protocol.ts`, `protocol-surface.json` | The pinned CLI's protocol surface (methods, decisions, params, item types, enums). |
| `transcript.ts`, `transcripts/*.jsonl` | Real `codex app-server` 0.159.2 runs (`gpt-6-luna`), redacted. |
| `fake-codex.test.ts`, `transcripts.test.ts` | The fake's own tests and the fixture hygiene check. |

Users of the fake:

- **e2e**: `packages/apps/app/e2e/fixtures/chat-codex.ts` and `e2e/chat/175`–`179-chat-codex-*.spec.ts`.
- **Driver tests**: `agents/codex/codex-chat-session.fake.test.ts` (the real driver against the fake as a child process).
- **Drift check**: `agents/codex/codex-protocol-drift.test.ts` (reads the surface + transcripts).
- **Recorder / surface generator**: `agents/codex/codex-app-server-recorder.live.ts`, `codex-protocol-surface.gen.ts`.

## Pinned version: 0.159.2

The fake reports `codex-cli 0.159.2`, the transcripts and the surface come from
it. Not the globally installed 0.139.0: on a ChatGPT login 0.139.0 can run no
turn at all (every model it lists — gpt-5.5, 5.4, 5.4-mini, 5.3-codex, 5.2 — is
refused, "not supported when using Codex with a ChatGPT account"; the account's
gpt-5.6-* models need "a newer version of Codex"). 0.159.2 is the newest release
≥30 days old at recording time (2026-10-30). Its cheapest model is `gpt-6-luna`.

## Wiring

```ts
const fake = createFakeCodex({ root: '/some/fresh/dir' })
// The app's computer resolves `codex` through this dir first:
launch({ env: { SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR: fake.binDir } })
const epoch = fake.setScenario({ processes: [{ defaultTurn: codexEchoTurn() }] })
```

`binDir/codex` is a generated wrapper: it sets `FAKE_CODEX_STATE_DIR` and execs
the script with the test runner's own Node. As with fake-claude, a dir merely
prepended to PATH loses to the login-shell PATH; `SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR`
(applied in `apps/computer/src/handlers/spawn-env.ts`) does not.

## Scenarios

```ts
import { cstep, cx, codexReply, codexEchoTurn, commandTurn } from '@slayzone/test-utils/fake-codex'

fake.setScenario({
  threads: ['seeded-thread-id'],        // ids thread/resume accepts (besides the ones this fake started)
  processes: [
    {
      turns: [codexReply('hi')],         // turns[i] runs for the i-th turn/start
      defaultTurn: codexEchoTurn(),      // every turn past `turns`
      handshake: { threadResume: { error: { code: -32000, message: 'stream disconnected' } } },
      turnStart: { replyDelayMs: 2_000 },// hold back the reply AND turn/started (no turn id yet)
      interrupt: 'ignore',               // or 'error'; default: ack {} + interrupted turn
      onSigterm: [cstep.emit(cx.error('late'))], sigtermExitCode: 143,
      methods: { 'model/list': { result: { data: [] } } }, // other client methods (else -32601)
    },
    { onStart: [cstep.stderr('boom\n'), cstep.exit(1)] }   // the respawn
  ]
})
```

### Steps (`cstep.*`)

| Step | Effect |
|---|---|
| `emit(...notifications)` / `emitGap(ms, ...)` | Write notifications (`{method, params}`), templates substituted. |
| `raw(line)` | Write a raw line (malformed output). |
| `stderr(text)`, `sleep(ms)`, `hang()`, `exit(code)` | As named. An interrupt aborts `sleep` / `hang`. |
| `request(method, params, branches)` | A server→client request. Blocks until the app replies; then runs `branches[decision]` (`accept`, `acceptForSession`, `decline`, `cancel`, a legacy `approved`/…, an object variant's key), `branches.error` for an error reply, else `branches.default`. |
| `approveCommand(cmd, branches)` / `approveFileChange(itemId, branches)` | The two v2 approvals with 0.159.2's params. |
| `endTurn(status, message?)` | End the turn yourself (`failed`, …). |
| `replay(transcript, {process, turn, speed})` | Play one recorded turn (below). |

Notifications (`cx.*`): `agentStarted/agentDelta/agentCompleted`, `reasoning*`,
`commandStarted/commandOutput/commandCompleted`, `fileChangeStarted/Completed`,
`turnDiff`, `mcpStarted/mcpCompleted`, `webSearchStarted/Completed`, `plan`,
`tokenUsage`, `error`, `serverRequestResolved`, `notification(method, params)`.

Template variables in every string: `{{threadId}}`, `{{turnId}}`, `{{cwd}}`,
`{{model}}`, `{{userText}}`, `{{turn}}`, `{{spawn}}`.

### What the fake does without being told (0.159.2, as recorded)

- **Responses carry no `jsonrpc`** (`{id, result}` / `{id, error}`).
- `initialize` → `{userAgent, codexHome, platformFamily, platformOs}`; `initialized` is logged.
- `thread/start` → a new thread (uuid), reply, then `thread/started`. The thread is remembered in the state dir, so a LATER spawn can resume it.
- `thread/resume` of an unknown id → `{code: -32600, message: 'no rollout found for thread id <id>'}` (recipe `resume-missing`).
- `turn/start` → `{turn: {id, status: 'inProgress'}}` at once; then `thread/status/changed active`, `turn/started`, the script, `thread/status/changed idle`, `turn/completed {completed}`. A turn past the script fails with an `error` naming it.
- Server request ids count from **0**. An answered request is followed by `serverRequest/resolved`.
- `turn/interrupt {threadId, turnId}` → `{}`, the turn ends `idle` + `turn/completed {interrupted}` with **no `item/completed` for a running item**, then `serverRequest/resolved` for each request left unanswered (recipes `interrupt-command`, `approval-interrupt`). Without `turnId` → error (it is required).
- **stdin closed** → exit 0 at once, even mid-turn (recipe `stdin-close-mid-turn`).
- **SIGTERM** → exit 0 at once, nothing more on stdout (recipe `sigterm-mid-turn`).
- Any other client method → `-32601`, logged (`run.unknownMethods()`).

### Harness failures (fail closed)

| Exit | Meaning | Reported by |
|---|---|---|
| 2 | argv is not `app-server …` (adapter drift). | `epoch.argvDrift()` |
| 3 | A spawn past the scripted processes (an unexpected respawn), or before any scenario. | `epoch.unscripted()`, `fake.orphans()` |

## Reading what happened

```ts
const run = await epoch.waitForRun(0, (r) => r.userTexts().length === 2)
run.requests('turn/start')   // [{id, method, params}] the app sent
run.userTexts(); run.threadId; run.resumedThread; run.notifications()
run.turnIds(); run.interrupts()          // [{turnId the app named (null = none), current}]
run.interruptedTurns(); run.serverRequests(); run.requestReplies() // [{requestId, method, decision, reply}]
run.abandonedRequests(); run.lateReplies(); run.unknownMethods(); run.replayMismatches()
run.sentMethods(); run.signals(); run.exit(); run.entries
```

A run is live: every accessor re-reads `state/epochs/<n>/procs/<i>/log.jsonl`.

## Transcripts

### Replay

`cstep.replay(codexTranscriptPath('approval-exec'), { turn: 3 })` plays the server
lines between that turn's `turn/start` and its `turn/completed`. Responses to the
recorder's own requests are skipped (the fake answered turn/start itself). A
recorded server request blocks until the app answers it, under a fresh id; an
answer that differs from the recording is logged (`run.replayMismatches()`).

### Recipes

| Recipe | Shows |
|---|---|
| `simple-turn` | One short reply, then stdin closed. |
| `stream-long` | A long reply: one agentMessage item, ~200 deltas. |
| `reasoning` | Effort medium (gpt-6-luna emitted no reasoning item). |
| `command-exec` | full-access: a command with live `outputDelta`. |
| `file-change` | apply_patch add then update: `fileChange` items, `turn/diff/updated`. |
| `approval-exec` | approval-required: command approvals accept / acceptForSession (then no ask for the same command) / decline. |
| `approval-file` | file-change approvals accept / decline. |
| `approval-interrupt` | An approval left unanswered, then `turn/interrupt`. |
| `interrupt-command`, `interrupt-text` | Interrupt while a command runs / mid-reply. |
| `web-search` | `web_search="live"`: a `webSearch` item (started with an EMPTY query). |
| `mcp-tool` | A local MCP server (`slz_echo`): an `mcpToolCall` item. |
| `plan-update` | update_plan asked for (gpt-6-luna answered without one). |
| `resume`, `resume-missing` | `thread/resume` working, and of an unknown id. |
| `model-refused`, `bad-model` | chat's default `gpt-5.5` refused on a ChatGPT login; an unknown model (a `warning`, then the same refusal). |
| `sigterm-mid-turn`, `stdin-close-mid-turn` | How the server ends. |

### Re-recording / moving the pin (after a CLI update)

```sh
npm i --prefix <dir> @openai/codex@<version>        # aside; the global codex is untouched
export SLAYZONE_CODEX_BIN_PATH=<dir>/node_modules/.bin/codex SLAYZONE_CODEX_RECORD_DIR=<one fixed scratch dir>
npx tsx packages/domains/terminal/src/server/agents/codex/codex-protocol-surface.gen.ts
npx tsx packages/domains/terminal/src/server/agents/codex/codex-app-server-recorder.live.ts [recipe…]
```

- Real model turns (the cheapest model, a few cents). Settings only by `-c`
  flags; the user's `~/.codex/config.toml` and login are read, never written by
  the script. The CLI ITSELF adds a `[projects."<cwd>"] trust_level = "trusted"`
  entry for every cwd it starts a thread in, hence one fixed record dir.
- It writes rollout files under `~/.codex/sessions/YYYY/MM/DD/` (their
  `session_meta.cwd` is the record dir): move them out afterwards so they do not
  show in the user's Codex history or usage stats.
- Every `SLAYZONE_*` env var is stripped from the child (the user's agent hooks
  report nothing to a running app). Redaction: thread/turn ids → templates, cwd,
  home, username, hostname, emails, JWTs, account and rate-limit figures.
- Then bump `FAKE_CODEX_VERSION` (fake-codex.mjs + index.ts), run the drift
  check and `transcripts.test.ts`, and review the diff.

## e2e (`packages/apps/app/e2e/fixtures/chat-codex.ts`)

```ts
import { test, expect, knownBug, codexReply } from '../fixtures/chat-codex'

test('…', async ({ codexChat }) => {
  const t = await codexChat.openTask({ title: 'x', scenario: { processes: [{ turns: [codexReply('hi')] }] } })
  await t.send('hello')
  await expect(t.panel.getByText('hi')).toBeVisible()
  expect((await t.run(0)).userTexts()).toEqual(['hello'])
  await t.events(); await t.conversations(); await t.storedThread()
})
```

- Same shape, guard and `knownBug()` as the Claude harness (`fixtures/chat.ts`).
- The worker's bin override holds only `codex`: these specs never start Claude.
- Startup stays `manual` (the reset's); `openTask` pre-spawns like the Restart button.
