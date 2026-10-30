# fake-claude: a scripted `claude` CLI for chat tests

`fake-claude.mjs` stands in for the real `claude` binary in the stream-json mode
SlayZone's chat (`claude-chat`) spawns it in. It plays a **scenario** (what to print, when, and how to
react to what the app sends) and **records** everything it receives. No network,
no account, no build step (plain ESM, Node builtins only).

| File | What |
|---|---|
| `fake-claude.mjs` | The CLI. |
| `scenario.ts` | Scenario types and the `ev` / `step` builders. |
| `index.ts` | `createFakeClaude()` plus readers for each spawn's log (`FakeEpoch`, `FakeRun`). |
| `transcript.ts` | Format of the recorded real-CLI runs, plus readers for it. |
| `transcripts/*.jsonl` | Real `claude` 2.1.312 runs (`--model haiku`), redacted. |
| `fake-claude.test.ts`, `transcripts.test.ts` | The fake's own tests and the fixture hygiene check. |

Users of the fake:

- **e2e**: `packages/apps/app/e2e/fixtures/chat.ts` and the specs in `e2e/chat/`.
- **Drift check**: `packages/domains/terminal/src/server/agents/claude-stream-drift.test.ts`.
- **Recorder**: `packages/domains/terminal/src/server/agents/claude-stream-recorder.live.ts`.

## Wiring

```ts
const fake = createFakeClaude({ root: '/some/fresh/dir' })
// The app's computer resolves `claude` through this dir first:
launch({ env: { SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR: fake.binDir } })
const epoch = fake.setScenario({ processes: [{ defaultTurn: echoTurn() }] })
```

`binDir/claude` is a generated wrapper. It sets `FAKE_CLAUDE_STATE_DIR` and then
execs the script with the test runner's own Node. The app passes the fake nothing
except argv and stdin, the same as it does for the real CLI.

> Putting `binDir` first on PATH is **not** enough. The computer adopts the login-shell PATH at boot, with the login shell's entries first, so a real `~/.local/bin/claude` would win. That is why `SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR` exists. It is applied in `apps/computer/src/handlers/spawn-env.ts`.

In e2e you do none of this yourself: `import { test } from '../fixtures/chat'`
and use the `chat` fixture (see "e2e" below).

## Scenarios

A scenario is plain JSON. `processes[i]` scripts the i-th spawn after
`setScenario()`. Each spawn atomically claims the next index.

```ts
import { ev, step, reply, echoTurn } from '@slayzone/test-utils/fake-claude'

fake.setScenario({
  processes: [
    {
      // turns[i] runs when the i-th user message arrives on stdin
      turns: [
        [step.emit(ev.init(), ev.toolUse({ id: 't1', name: 'Bash', input: { command: 'ls' } }))],
        reply('second answer')
      ],
      defaultTurn: echoTurn(),          // every turn past `turns`
      onStart: [],                      // before stdin is read (startup failures)
      onInterrupt: undefined,           // unset → the real CLI's reaction (recorded)
      onSigterm: undefined,             // unset → exit 143 at once
      controlResponses: { set_model: 'error' }, // default: 'success' for all
    },
    { onStart: [step.stderr('boom\n'), step.exit(1)] } // the respawn
  ]
})
```

### Steps

| Step | Effect |
|---|---|
| `{ emit: event \| event[], gapMs? }` | Write events as JSON lines. |
| `{ emitSplit: event, gapMs? }` | Write ONE event as two stdout chunks, split inside its first multi-byte character (é, emoji). |
| `{ emitRaw: 'text' }` | Write a raw line (malformed output). |
| `{ stderr: 'text' }` | Write to stderr. |
| `{ sleep: ms }` | Wait. An interrupt aborts the wait. |
| `{ hang: true }` | Wait until the turn is interrupted or the process is killed. |
| `step.request({tool_name, input, tool_use_id, …}, {allow, deny})` | Emit `control_request{subtype:'can_use_tool'}` (any CLI field: `description`, `permission_suggestions`, `agent_id`, `mcp_server`, `decision_reason`, …) and block until the app answers it. Then run the branch that matches `behavior` (an error reply runs `deny`). |
| `step.hostRequest({subtype, …}, timeoutMs?)` | Emit a control_request the app does not implement (`hook_callback`, `mcp_message`) and wait for its reply (default 30 s, the CLI's hook timeout; then withdrawn). Read it with `run.hostReplies()`. |
| `{ exit: code }` / `{ exit: null, signal: 'SIGSEGV' }` | Exit with that code, or kill itself with that signal. |
| `{ replay: { transcript, process?, turn?, speed? } }` | Re-emit one recorded turn (see below). |

### Template variables

Every string in an emitted event goes through substitution:

| Variable | Value |
|---|---|
| `{{sessionId}}` | The `--session-id` / `--resume` value. **The app needs `system/init` to echo it, or it never stores the conversation id.** |
| `{{cwd}}` | The spawn's working directory. |
| `{{model}}` | From `--model`; an acked `set_model` updates it. |
| `{{permissionMode}}` | From `--permission-mode`; an acked `set_permission_mode` updates it. |
| `{{effort}}` | From `--effort`. |
| `{{userText}}` | The message that started this turn. |
| `{{turn}}`, `{{spawn}}` | The turn and spawn indexes. |
| `{{command}}` | The slash command the real CLI would run for this message, or `''`. Like 2.1.312: only when the message's LAST block is the `/name …` text (`[image, text '/x a']` runs `x`; `[text '/x a', image]` is plain text to the model). |

### What the fake does without being told

The defaults copy CLI 2.1.312 behaviour as recorded:

- **Control requests** (`interrupt`, `set_model`, `set_permission_mode`):
  - Acked at once with the real payload: `{still_queued:[]}`, `{model}` or `{mode}`.
  - A mode change is followed by `system/status {permissionMode}`.
  - `controlResponses` can turn any of them into `'error'` or `'ignore'`. The app falls back to kill + respawn after a 30 s timeout.
- **`initialize`** (the app sends it first on every spawn): answered `{commands: []}`. Script the CLI's command descriptions + argument hints with `controlPayloads: { initialize: { commands: [{ name, description, argumentHint }] } }` (any subtype's success payload can be extended this way).
- **Interrupt mid-turn**:
  - Every open tool_use gets a rejecting `tool_result`.
  - Then a user text `[Request interrupted by user(for tool use)]`.
  - Then `result{subtype:'error_during_execution', terminal_reason:'aborted_tools'|'aborted_streaming'}`.
  - The process stays alive for the next turn.
- **Answers to `can_use_tool`** (a `request` step, or a replayed one):
  - An allow with a session `setMode` update switches `{{permissionMode}}` and emits `system/status {permissionMode}`; so does allowing ExitPlanMode in plan mode (→ `default`). Not during replay: the recording has the CLI's own status lines.
  - A deny with `interrupt: true` aborts the turn like an interrupt (below).
  - An interrupt while the request waits withdraws it: `control_cancel_request {request_id}`. A later answer is ignored and logged (`run.lateAnswers()`).
  - A replayed request answered differently from the recording is logged (`run.replayMismatches()`): the recorded output after it assumes the recorded answer.
- **Delivery acks** (a user message that carries a `uuid`; chat always sends one, with `--replay-user-messages`):
  - `command_lifecycle queued` as soon as it arrives, also mid-turn.
  - `started` and the replayed message (`{type:'user', isReplay:true, uuid}`) when its turn begins.
  - `completed` after the turn's result, or `cancelled` when the turn is interrupted.
  - `lifecycle: 'none'` on a process plays a CLI that sends none of these (the app then infers delivery from the turn).
- **stdin closed**: the fake finishes the current turn and exits 0.
- **SIGTERM**: exit 143. Set `onSigterm` to keep talking first; this is how a replaced process that still emits events is scripted.
- **`--allow-dangerously-skip-permissions`** leaves the mode at `default`, as on the real CLI. Only `--dangerously-skip-permissions` means bypass.

### Conversation control (chat A)

As 2.1.312 behaves (chat-a checks R1–R6, R3b):

- **Session file**: with `CLAUDE_CONFIG_DIR` set (never otherwise), the fake keeps the conversation in `<CLAUDE_CONFIG_DIR>/projects/<encoded cwd>/<id>.jsonl`: user and assistant records chained by `parentUuid`, append-only. Every streamed assistant line carries its record's `uuid`; a scripted uuid played again gets a new one.
- **`--resume`** seeds the conversation from the active branch of that file (the last main-chain record, walked back through `parentUuid`).
- **Fork**: `--resume S --resume-session-at A --fork-session --session-id N` copies S up to record `A` into N. S is only read; N is written with its first record (an unused fork leaves no file). An unknown `A` exits 1 with the CLI's `No message found with message.uuid of: …`.
- **Dedupe**: a user message whose `uuid` the conversation already holds is acked `completed` only and runs no turn.
- **`rewind_conversation`** answers `{rewound, targetMessageUuid, prefillText, precedingAssistantUuid}` or `{rewound:false, reason:'target_not_found'}`; the next message branches off the record before the target.
- **`rewind_files`** needs `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true` (else the CLI's error). Checkpoints come from the scenario's `fileCheckpoints` (by user-message index); a dry run reports, a real run writes the `restore` files.
- **`interrupt`** answers the real `still_queued`; `cancel_async_message` withdraws a queued message (`{cancelled}`).
- **`apply_flag_settings`** is acked with no response body and sets `{{effort}}`.
- `controlResponses[subtype]` may also be `{success: payload}` or `{error}`.
- `ackDelayMs` / `ackDelayFrom` delay a message's acks (the message is already in the conversation), for the restart-between-write-and-ack window.
- `{ parallel: Step[][] }` runs branches at once (two prompts pending together).
- **TUI**: a process script `{ tui: true }` plays the interactive CLI (no `-p`): it logs its argv and env, stays up, and exits on a signal. Without one, a TUI-style spawn is still argv drift.
- The `start` log entry records `env` (`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`, `CLAUDE_CONFIG_DIR`), `at` and `peersAlive` (other fake processes alive at start).
- `session-file.ts`: `writeSessionFile` (seed a conversation), `readSessionFile`, `sessionFilePath`, `fileSha256`.

### Harness failures (fail closed)

| Exit | Meaning | Where it is reported |
|---|---|---|
| 2 | The argv is missing one of the flags chat always passes (`-p`, stream-json in/out, `--verbose`, `--permission-prompt-tool stdio`, `--replay-user-messages`, `--include-partial-messages`). | `epoch.argvDrift()` |
| 3 | A spawn past the scripted processes. Usually an unexpected respawn. | `epoch.unscripted()` |
| 3 | A spawn before any scenario was set. | `fake.orphans()` |

A turn past `turns` with no `defaultTurn` gets an error `result` naming the turn.

## Reading what happened

```ts
const run = await epoch.waitForRun(0, (r) => r.userMessages().length === 2)
run.argv; run.sessionId; run.resumed; run.flag('--model')
run.userMessages()       // texts the app sent (plain-string messages only)
run.userContents()       // every user message as written: string or block array (attachments)
run.controlRequests()    // [{subtype:'interrupt'}, {subtype:'set_model', model}]
run.decisions()          // answers to the fake's can_use_tool requests
run.hostReplies()        // replies to hostRequest steps (or 'timeout')
run.cancels(); run.lateAnswers(); run.replayMismatches()
run.signals(); run.exit(); run.stdoutLines(); run.entries   // raw log
run.forked; run.tui; run.env; run.peersAliveAtStart       // chat A
run.rewound(); run.duplicateUserUuids(); run.controlRequests('rewind_files')
```

A `FakeRun` is live: every accessor re-reads
`state/epochs/<n>/procs/<i>/log.jsonl`, so a run you fetched early still shows
what arrived later.

## Transcripts

### Replay

Replay a recorded turn instead of writing events by hand:

```ts
turns: [[step.replay(transcriptPath('permission-bash'), { turn: 0 })]]
```

- Turns are split at the recorded user messages.
- A recorded `can_use_tool` request blocks until the app answers it.
- Recorded `control_response`s to the recorder's own requests are skipped. The fake answers the app's live control requests itself.
- `speed` (default 0) replays the recorded gaps, divided by `speed`. 0 means no gaps.

### Recipes

| Recipe | Shows |
|---|---|
| `tool-turn` | Read, then Bash, in acceptEdits. Two turns in one process. |
| `permission-bash` | Default mode: `can_use_tool` for Bash. Turn 1 allowed, turn 2 denied. |
| `ask-user-question` | AskUserQuestion answered via `updatedInput.answers`, as the chat card does it. |
| `exit-plan-deny` | ExitPlanMode denied the way older builds' driver did, then `set_permission_mode` + `__slay_plan_approved__` (pre-prompt-card flow; kept for history replays). |
| `exit-plan-allow` | ExitPlanMode allowed: the CLI leaves plan mode itself. |
| `permission-cancel-interrupt` | Default mode: a Bash request left unanswered, then an interrupt — the CLI withdraws it (`control_cancel_request`). |
| `ask-user-question-preview` | AskUserQuestion whose options carry `preview`, answered with `answers` + `annotations` (preview + notes). |
| `compact` | `/compact`: `system/status compacting`, `compact_boundary`, the summary as a user **string**. |
| `resume`, `resume-missing` | `--resume` working, and `--resume` of an unknown id (stderr + `error_during_execution`, 0 turns, exit 1). |
| `interrupt-tool`, `interrupt-text` | Interrupt with and without an open tool. |
| `control-requests` | `set_model` / `set_permission_mode` acks. |

### Re-recording (after a CLI update)

```sh
npx tsx packages/domains/terminal/src/server/agents/claude-stream-recorder.live.ts [recipe…]
```

- This runs the real CLI with `--model haiku`, which costs a few cents.
- The recorder spawns with the adapter's own `buildSpawnArgs`, plus `--strict-mcp-config --setting-sources project`, so the user's MCP servers, hooks and plugins stay out of the recording.
- Redaction:
  - session ids and the cwd become template variables;
  - home and temp paths, emails and rate-limit figures are scrubbed;
  - account MCP tools are dropped.
- Review the diff, then run the drift check and `transcripts.test.ts`.

## Token streaming and command tasks (stream.ts, tasks.ts)

Chat always spawns with `--include-partial-messages`, so the real CLI streams every main-thread message as `stream_event` frames (sub-agents never stream). `streamMessage(messageId, blocks, { gapMs?, open? })` returns the steps that play ONE message in 2.1.312's order (spike item 9): `message_start`; per block `content_block_start` → deltas → the saved `assistant` event for the block (same `messageId`) → `content_block_stop`; then `message_delta` + `message_stop`.

```ts
...streamMessage('msg_1', [
  { thinking: ['I should ', 'list files.'] },          // [] = thinking display omitted
  { toolUse: { id: 'toolu_1', name: 'Bash', input: { command: 'ls' } } },
], { gapMs: 200 }),
...streamMessage('msg_2', [{ text: ['Hel', 'lo'] }], { open: true }), // cut short: no saved event, no stops
```

`streamEv.*` builds single frames. A `task` step (`taskStep(spec)`) runs a command as a CLI task, the way 2.1.312 does (spike item 14; runtime in fake-claude-tasks.mjs). Emit the command's `tool_use` first.

| Spec | Effect |
|---|---|
| foreground (default) | `task_started` after `startAfterMs` (default 300; the real CLI waits ~3 s, and a command done by then never becomes a task); output chunks appear at `atMs`; at `endAtMs`: `task_notification completed`, then the tool_result with the whole output. The step blocks until then. |
| `background: true` | `background_tasks_changed` + `task_started {is_backgrounded:true}` + tool_result "Command running in background with ID: …" at once; the step returns. At `endAtMs`: `task_updated {status:'completed'}` + `task_notification` + `background_tasks_changed`, then `afterBackgroundExit` steps (the CLI's own follow-up turn). |

The fake answers the app's task control requests itself:

- `get_task_output {task_id}` → `{output (last 8 KiB), total_bytes, truncated}`; empty once a foreground command finished; kept (with `[exited with code N]`) for a background one; an unknown id is an error reply. Each poll is logged (`task-poll`); read the requests with `run.controlRequests()`.
- `background_tasks {tool_use_id}` on a running foreground command → `background_tasks_changed` + `task_updated {patch:{is_backgrounded:true}}`, ack `{backgrounded:true}`, tool_result "Command was manually backgrounded…"; the command runs on in the background.
- `stop_task {task_id}` on a running command → `task_updated {status:'killed'}` + `task_notification stopped` + `background_tasks_changed`, ack `{}`, output ends with `[killed]`. Not verified on the real CLI for a FOREGROUND command (played as a killed command with an error tool_result).

## e2e (`packages/apps/app/e2e/fixtures/chat.ts`)

```ts
import { test, expect, knownBug, reply, step, ev } from '../fixtures/chat'

test('…', async ({ chat }) => {
  const t = await chat.openTask({ title: 'x', scenario: { processes: [{ turns: [reply('hi')] }] } })
  await t.send('hello')                         // types into the real composer
  await expect(t.panel.getByText('hi')).toBeVisible()
  expect((await t.run(0)).userMessages()).toEqual(['hello'])
  await t.events()                              // persisted chat_events rows
})
```

- **Session files**: every worker gets its own `CLAUDE_CONFIG_DIR` (`chat.claudeConfigDir`); `t.sessionFile(id)` is a conversation's file in the task's repo.
- **Terminal agents**: a TUI pty runs `claude` through the user's login shell, whose rc files put the real CLI first on PATH again — the bin override cannot reach it. A spec that needs a live terminal agent points the claude-code mode's commands at the fake by absolute path (see `154-chat-handoff.spec.ts`) or stubs spawns with `pty.testSetPtyCreateCapture`.
- **Startup mode**: chat specs keep `manual` startup. Any other mode turns on the warm pool, which pre-boots a TUI `claude` through a login shell.
- **Spawning**: `openTask` spawns the agent the way the Restart button does (`chat.start`) and waits for `session-spawn`. Pass `spawn: 'on-send'` to test the lazy path.
- **Watchdog**: `chat.setWatchdogTimings({...})` shortens the watchdog. It is a PLAYWRIGHT-only tRPC seam, and the defaults come back after each test.
- **Guard**: an afterEach guard fails the test on any unscripted spawn, argv drift or orphan spawn.
- **Open bugs**: `knownBug({ audit, fixedBy, what })` marks a still-open bug.
  - Call it after the preconditions are asserted, right before the assertion the bug breaks. The test is then expected to fail.
  - When the bug is fixed, the test passes unexpectedly, which Playwright reports as a failure. Delete the call then.
  - `REVEAL_KNOWN_BUGS=1` turns the marking off, so you can see the real failure.
