// Scripted stand-in for the `claude` CLI in the stream-json mode chat spawns it in
// (`claude-code-adapter.ts`). Plays the scenario the test wrote into the state dir
// and records everything it receives. Zero dependencies, plain ESM, so it starts
// under any Node (or Electron as Node) without a build step. How to write a
// scenario: README.md next to this file. Types: scenario.ts.
//
// Run through the wrapper `createFakeClaude()` generates (bin/claude), which bakes
// in FAKE_CLAUDE_STATE_DIR — the app passes nothing to the fake but argv + stdin,
// exactly as it does to the real CLI.

import fs from 'node:fs'
import path from 'node:path'

/** What `--version` reports: the real CLI the transcripts were recorded with. */
export const FAKE_CLAUDE_VERSION = '2.1.312'

/** Flags SlayZone's chat transport always passes. Missing one = adapter drift. */
const REQUIRED_FLAGS = [
  ['-p'],
  ['--input-format', 'stream-json'],
  ['--output-format', 'stream-json'],
  ['--verbose'],
  ['--permission-prompt-tool', 'stdio'],
  ['--replay-user-messages']
]

const EXIT_ARGV_DRIFT = 2
const EXIT_UNSCRIPTED = 3

const INTERRUPTED_TOOL_TEXT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."

const t0 = Date.now()
const argv = process.argv.slice(2)

if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(`${FAKE_CLAUDE_VERSION} (Claude Code)\n`)
  process.exit(0)
}

const stateDir = process.env.FAKE_CLAUDE_STATE_DIR
if (!stateDir) {
  process.stderr.write(
    'fake-claude: FAKE_CLAUDE_STATE_DIR is not set (run it through its wrapper)\n'
  )
  process.exit(EXIT_UNSCRIPTED)
}

// --- claim this spawn's script ------------------------------------------------

const epoch = readCurrentEpoch()
const epochDir = epoch ? path.join(stateDir, 'epochs', epoch) : null
const scenario = epochDir
  ? JSON.parse(fs.readFileSync(path.join(epochDir, 'scenario.json'), 'utf8'))
  : null
const index = epochDir ? claimIndex(epochDir) : -1
const logFile = epochDir
  ? path.join(epochDir, 'procs', String(index), 'log.jsonl')
  : path.join(stateDir, 'unscripted.jsonl')

// `start` is logged once the signal handlers are installed (below), so a test that
// waits for it and then signals the process never races the default action.
let started = false
function logStart() {
  if (started) return
  started = true
  log('start', { argv, cwd: process.cwd(), pid: process.pid, epoch, index })
}

const missing = REQUIRED_FLAGS.filter((flag) => !hasFlag(flag))
if (missing.length > 0) {
  const text = `fake-claude: adapter argv drift — missing ${missing.map((f) => f.join(' ')).join(', ')}\n`
  logStart()
  log('argv-drift', { missing })
  process.stderr.write(text)
  process.exit(EXIT_ARGV_DRIFT)
}

const script =
  scenario?.processes?.[index] ??
  (scenario?.repeatLast && scenario.processes?.length ? scenario.processes.at(-1) : undefined)
if (!script) {
  const text = `fake-claude: no script for spawn #${index} (epoch ${epoch ?? 'none'})\n`
  logStart()
  log('unscripted', { index })
  process.stderr.write(text)
  process.exit(EXIT_UNSCRIPTED)
}

// --- template context ---------------------------------------------------------

const resumeId = flagValue('--resume')
const ctx = {
  sessionId: resumeId ?? flagValue('--session-id') ?? '',
  resumed: resumeId !== undefined,
  cwd: process.cwd(),
  model: flagValue('--model') ?? 'default',
  // Like the real CLI: only `--dangerously-skip-permissions` or an explicit mode
  // changes it. `--allow-dangerously-skip-permissions` merely ALLOWS a later switch
  // to bypass — the session still starts in `default` (verified on 2.1.312).
  permissionMode: argv.includes('--dangerously-skip-permissions')
    ? 'bypassPermissions'
    : (flagValue('--permission-mode') ?? 'default'),
  effort: flagValue('--effort') ?? '',
  userText: '',
  turn: 0,
  spawn: index
}

// --- stdin --------------------------------------------------------------------

/** Pending user messages: `{ text, uuid?, content }`. */
const userQueue = []
let userWaiter = null
/**
 * Delivery acks for a message that carried a `uuid`, as 2.1.312 sends them with
 * `--replay-user-messages` (spike transcripts 05/14): `command_lifecycle queued`
 * on receipt (even mid-turn), `started` + the replayed message when its turn
 * begins, `completed` after the turn's result (`cancelled` when interrupted).
 * `lifecycle: 'none'` plays a CLI that sends none of it.
 */
const acksDelivery = () => script.lifecycle !== 'none' && argv.includes('--replay-user-messages')
let stdinEnded = false
const pendingRequests = new Map()
let turnAbort = null
let turnRunning = false
/** tool_use ids emitted without a matching tool_result — an interrupt rejects them. */
const openToolUses = new Set()

let stdinBuf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk
  let nl = stdinBuf.indexOf('\n')
  while (nl >= 0) {
    const line = stdinBuf.slice(0, nl)
    stdinBuf = stdinBuf.slice(nl + 1)
    if (line.trim()) onStdinLine(line)
    nl = stdinBuf.indexOf('\n')
  }
})
process.stdin.on('end', () => {
  stdinEnded = true
  log('stdin-end', {})
  if (userWaiter) {
    userWaiter(null)
    userWaiter = null
  }
})
process.stdout.on('error', (err) => {
  log('stdout-error', { message: String(err) })
  process.exit(0)
})

function onStdinLine(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    log('stdin-raw', { line })
    return
  }
  log('stdin', { msg })
  if (msg.type === 'control_request') return void onControlRequest(msg)
  if (msg.type === 'control_response') {
    const id = msg.response?.request_id
    const waiter = pendingRequests.get(id)
    if (waiter) {
      pendingRequests.delete(id)
      waiter.resolve(msg.response)
    } else {
      // Like the real CLI: an answer to a withdrawn (or already answered)
      // request is ignored — recorded so a test can tell.
      log('late-answer', { requestId: id })
    }
    return
  }
  if (msg.type === 'user') {
    const content = msg.message?.content
    if (Array.isArray(content) && content[0]?.type === 'tool_result') return
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
          : ''
    const uuid = typeof msg.uuid === 'string' ? msg.uuid : undefined
    const entry = { text, uuid, content }
    if (uuid && acksDelivery()) void lifecycle(uuid, 'queued')
    if (userWaiter) {
      const w = userWaiter
      userWaiter = null
      w(entry)
    } else userQueue.push(entry)
  }
}

function lifecycle(uuid, state) {
  return writeLine({
    type: 'command_lifecycle',
    command_uuid: uuid,
    state,
    uuid: `lc-${uuid}-${state}`,
    session_id: ctx.sessionId
  })
}

function nextUserMessage() {
  if (userQueue.length > 0) return Promise.resolve(userQueue.shift())
  if (stdinEnded) return Promise.resolve(null)
  return new Promise((resolve) => {
    userWaiter = resolve
  })
}

async function onControlRequest(msg) {
  const subtype = msg.request?.subtype
  const mode = script.controlResponses?.[subtype] ?? 'success'
  log('control', { subtype, request: msg.request, reply: mode })
  if (mode === 'ignore') return
  if (mode === 'error') {
    await writeLine({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: msg.request_id,
        error: `fake-claude: ${subtype} refused by scenario`
      }
    })
    return
  }
  // Reply payloads as the real CLI sends them (recorded: control-requests,
  // interrupt-* transcripts).
  let payload = {}
  if (subtype === 'set_model' && typeof msg.request.model === 'string') {
    ctx.model = msg.request.model
    payload = { model: ctx.model }
  }
  if (subtype === 'set_permission_mode' && typeof msg.request.mode === 'string') {
    ctx.permissionMode = msg.request.mode
    payload = { mode: ctx.permissionMode }
  }
  if (subtype === 'interrupt') payload = { still_queued: [] }
  await writeLine({
    type: 'control_response',
    response: { subtype: 'success', request_id: msg.request_id, response: payload }
  })
  if (subtype === 'set_permission_mode') {
    await emit({
      type: 'system',
      subtype: 'status',
      status: null,
      permissionMode: ctx.permissionMode,
      session_id: '{{sessionId}}'
    })
  }
  if (subtype === 'interrupt' && turnRunning && turnAbort) {
    log('interrupt', { turn: ctx.turn })
    turnAbort.abort()
  }
}

// --- signals ------------------------------------------------------------------

let sigtermHandled = false
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    log('signal', { signal })
    // One kill can arrive twice (process group + pid); a scripted lingering
    // process keeps lingering until its steps end or SIGKILL.
    if (signal === 'SIGTERM' && sigtermHandled) return
    if (signal === 'SIGTERM' && script.onSigterm) {
      // Scenario keeps the process alive past SIGTERM (a replaced process that
      // is still talking). It exits when its steps end, or on SIGKILL.
      sigtermHandled = true
      void runSteps(script.onSigterm, null).then(
        () => exit(143),
        (err) => {
          log('error', { message: String(err) })
          exit(143)
        }
      )
      return
    }
    exit(signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 129)
  })
}

logStart()

// --- step interpreter ---------------------------------------------------------

class Aborted extends Error {}

function substitute(value) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in ctx ? String(ctx[key]) : whole))
  }
  if (Array.isArray(value)) return value.map(substitute)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v)
    return out
  }
  return value
}

function trackTools(event) {
  if (event?.type === 'assistant') {
    for (const block of event.message?.content ?? []) {
      if (block?.type === 'tool_use' && block.id) openToolUses.add(block.id)
    }
  }
  if (event?.type === 'user') {
    for (const block of event.message?.content ?? []) {
      if (block?.type === 'tool_result' && block.tool_use_id) openToolUses.delete(block.tool_use_id)
    }
  }
}

function write(chunk) {
  return new Promise((resolve) => {
    process.stdout.write(chunk, () => resolve())
  })
}

async function writeLine(event) {
  const line = JSON.stringify(event)
  await write(`${line}\n`)
  log('stdout', { line })
}

async function emit(raw) {
  const event = substitute(raw)
  trackTools(event)
  // A status frame reporting a mode (scripted, replayed or from a prompt
  // answer) is the CLI's mode from now on.
  if (event?.type === 'system' && event.subtype === 'status') {
    if (typeof event.permissionMode === 'string') ctx.permissionMode = event.permissionMode
  }
  await writeLine(event)
}

/** Write one event as two raw chunks, split inside its first multi-byte character. */
async function emitSplit(raw, gapMs) {
  const event = substitute(raw)
  trackTools(event)
  const line = JSON.stringify(event)
  const bytes = Buffer.from(`${line}\n`, 'utf8')
  let cut = -1
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 0xc0) {
      cut = i + 1 // after the lead byte: the continuation bytes land in chunk 2
      break
    }
  }
  if (cut < 0) throw new Error('emitSplit: event has no multi-byte character to split')
  await write(bytes.subarray(0, cut))
  await sleep(gapMs ?? 80, null)
  await write(bytes.subarray(cut))
  log('stdout', { line, splitAtByte: cut })
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Aborted())
    })
  })
}

/**
 * Send one control_request to the app and wait for its control_response.
 * Interrupted (signal) or timed out → withdrawn with `control_cancel_request`,
 * as CLI 2.1.312 does; a timeout resolves null.
 */
function askHost(requestId, request, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null
    const withdraw = () => {
      pendingRequests.delete(requestId)
      if (timer) clearTimeout(timer)
      log('cancel', { requestId })
      void writeLine({ type: 'control_cancel_request', request_id: requestId })
    }
    pendingRequests.set(requestId, {
      resolve: (reply) => {
        if (timer) clearTimeout(timer)
        resolve(reply)
      }
    })
    signal?.addEventListener('abort', () => {
      if (!pendingRequests.has(requestId)) return
      withdraw()
      reject(new Aborted())
    })
    if (timeoutMs) {
      timer = setTimeout(() => {
        withdraw()
        resolve(null)
      }, timeoutMs)
    }
    void writeLine({ type: 'control_request', request_id: requestId, request })
  })
}

/** Log the app's answer to a `can_use_tool`; a deny + interrupt aborts the turn. */
function recordDecision(requestId, toolName, reply) {
  const behavior = reply.subtype === 'error' ? 'error' : reply.response?.behavior
  log('decision', { requestId, toolName, behavior, reply })
  if (behavior === 'deny' && reply.response?.interrupt === true) throw new Aborted()
  return behavior
}

/**
 * The mode an allow switches to, as the real CLI does: a session `setMode`
 * update, or leaving plan mode when ExitPlanMode is approved without one.
 */
async function applyModeChange(toolName, reply) {
  const updates = Array.isArray(reply.response?.updatedPermissions)
    ? reply.response.updatedPermissions
    : []
  const setMode = updates.find((u) => u?.type === 'setMode' && typeof u.mode === 'string')
  const next = setMode
    ? setMode.mode
    : toolName === 'ExitPlanMode' && ctx.permissionMode === 'plan'
      ? 'default'
      : null
  if (!next || next === ctx.permissionMode) return
  await emit({
    type: 'system',
    subtype: 'status',
    status: null,
    permissionMode: next,
    session_id: '{{sessionId}}'
  })
}

let requestSeq = 0
async function request(step, signal) {
  requestSeq += 1
  const requestId = `fake_req_${ctx.spawn}_${requestSeq}`
  const req = substitute(step.request)
  const reply = await askHost(
    requestId,
    { subtype: 'can_use_tool', display_name: req.tool_name, ...req },
    signal
  )
  const behavior = recordDecision(requestId, req.tool_name, reply)
  if (behavior === 'allow') await applyModeChange(req.tool_name, reply)
  const branch = behavior === 'allow' ? step.then?.allow : step.then?.deny
  if (branch) await runSteps(branch, signal)
}

let hostSeq = 0
async function hostRequest(step, signal) {
  hostSeq += 1
  const requestId = `fake_host_${ctx.spawn}_${hostSeq}`
  const req = substitute(step.hostRequest)
  const reply = await askHost(requestId, req, signal, step.timeoutMs ?? 30000)
  log('host-reply', { requestId, subtype: req.subtype, reply: reply ?? 'timeout' })
}

async function runSteps(steps, signal) {
  for (const step of steps ?? []) {
    if (signal?.aborted) throw new Aborted()
    if ('emit' in step) {
      const events = Array.isArray(step.emit) ? step.emit : [step.emit]
      for (const [i, event] of events.entries()) {
        if (i > 0 && step.gapMs) await sleep(step.gapMs, signal)
        await emit(event)
      }
    } else if ('emitSplit' in step) await emitSplit(step.emitSplit, step.gapMs)
    else if ('emitRaw' in step) {
      await write(`${substitute(step.emitRaw)}\n`)
      log('stdout', { line: step.emitRaw, raw: true })
    } else if ('stderr' in step) {
      const text = substitute(step.stderr)
      await new Promise((resolve) => process.stderr.write(text, () => resolve()))
      log('stderr', { text })
    } else if ('sleep' in step) await sleep(step.sleep, signal)
    else if ('hang' in step) await sleep(2 ** 31 - 1, signal)
    else if ('request' in step) await request(step, signal)
    else if ('hostRequest' in step) await hostRequest(step, signal)
    else if ('exit' in step) {
      if (step.signal) {
        log('exit', { signal: step.signal })
        process.kill(process.pid, step.signal)
        await sleep(2 ** 31 - 1, null)
      }
      exit(step.exit ?? 0)
    } else if ('replay' in step) await replay(step.replay, signal)
    else throw new Error(`fake-claude: unknown step ${JSON.stringify(step)}`)
  }
}

/** Default reaction to an interrupt — mirrors the real CLI (2.1.312; interrupt-tool / interrupt-text transcripts). */
function defaultInterruptSteps() {
  const steps = []
  for (const id of openToolUses) {
    steps.push({
      emit: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', content: INTERRUPTED_TOOL_TEXT, is_error: true, tool_use_id: id }
          ]
        },
        parent_tool_use_id: null,
        session_id: '{{sessionId}}'
      }
    })
  }
  const hadTools = openToolUses.size > 0
  steps.push({
    emit: [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: hadTools
                ? '[Request interrupted by user for tool use]'
                : '[Request interrupted by user]'
            }
          ]
        },
        parent_tool_use_id: null,
        session_id: '{{sessionId}}'
      },
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: hadTools ? 3 : 2,
        stop_reason: hadTools ? 'tool_use' : null,
        terminal_reason: hadTools ? 'aborted_tools' : 'aborted_streaming',
        errors: [
          `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=${hadTools ? 'tool_use' : 'null'}`
        ],
        session_id: '{{sessionId}}',
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        },
        modelUsage: {},
        permission_denials: []
      }
    ]
  })
  return steps
}

// --- transcript replay --------------------------------------------------------

/**
 * Replay one turn of one process of a recorded transcript (format: transcript.ts).
 * Turns are delimited by the recorded user messages. Recorded stdout is re-emitted;
 * a recorded `can_use_tool` request blocks until the app answers it. Recorded
 * control_responses to the RECORDER's own requests (interrupt, set_model) are
 * skipped — the fake answers the app's live control requests itself.
 */
async function replay(spec, signal) {
  const records = fs
    .readFileSync(spec.transcript, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
  const procIndex = spec.process ?? 0
  const turnIndex = spec.turn ?? 0
  const speed = spec.speed ?? 0 // 0 = no recorded delays
  let proc = -1
  let turn = -1
  let prevT = null
  for (const rec of records) {
    if (rec.kind === 'process') {
      proc += 1
      turn = -1
      continue
    }
    if (proc !== procIndex) continue
    if (rec.kind === 'stdin') {
      const msg = JSON.parse(rec.line)
      const content = msg.message?.content
      const isToolResult = Array.isArray(content) && content[0]?.type === 'tool_result'
      if (msg.type === 'user' && !isToolResult) {
        turn += 1
        if (turn > turnIndex) return
      }
      continue
    }
    if (turn !== turnIndex) continue
    if (rec.kind === 'stdout') {
      const event = JSON.parse(rec.line)
      if (event.type === 'control_response') continue
      if (speed > 0 && prevT !== null) await sleep(Math.max(0, (rec.t - prevT) / speed), signal)
      prevT = rec.t
      if (event.type === 'control_request' && event.request?.subtype === 'can_use_tool') {
        // The recorded output that follows assumes the recorded answer; a
        // different answer is recorded so a test can't silently rely on it.
        const recorded = recordedDecision(records, event.request_id)
        const sub = substitute(event)
        const response = await askHost(sub.request_id, sub.request, signal)
        const behavior = recordDecision(sub.request_id, sub.request.tool_name, response)
        if (recorded && behavior !== recorded) {
          log('replay-mismatch', { requestId: sub.request_id, recorded, got: behavior })
        }
        continue
      }
      await emit(event)
    } else if (rec.kind === 'stderr') {
      await new Promise((resolve) => process.stderr.write(rec.text, () => resolve()))
      log('stderr', { text: rec.text })
    }
  }
}

/** The behavior the recorder answered a recorded request with. */
function recordedDecision(records, requestId) {
  for (const rec of records) {
    if (rec.kind !== 'stdin') continue
    const msg = JSON.parse(rec.line)
    if (msg.type === 'control_response' && msg.response?.request_id === requestId) {
      return msg.response.subtype === 'error' ? 'error' : msg.response.response?.behavior
    }
  }
  return null
}

// --- main ---------------------------------------------------------------------

let exiting = false
function exit(code) {
  if (exiting) return
  exiting = true
  log('exit', { code })
  process.exit(code)
}

async function main() {
  await runSteps(script.onStart, null)
  for (;;) {
    const message = await nextUserMessage()
    if (message === null) break
    const { text, uuid, content } = message
    ctx.userText = text
    const acks = Boolean(uuid) && acksDelivery()
    if (acks) {
      await lifecycle(uuid, 'started')
      await writeLine({
        type: 'user',
        isReplay: true,
        uuid,
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: ctx.sessionId
      })
    }
    const steps = script.turns?.[ctx.turn] ?? script.defaultTurn
    ctx.turn += 1
    if (!steps) {
      log('unscripted-turn', { turn: ctx.turn - 1, text })
      await emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 0,
        result: `fake-claude: no script for turn #${ctx.turn - 1}`,
        session_id: '{{sessionId}}',
        usage: {},
        modelUsage: {},
        permission_denials: []
      })
      if (acks) await lifecycle(uuid, 'completed')
      continue
    }
    turnAbort = new AbortController()
    turnRunning = true
    let interrupted = false
    try {
      await runSteps(steps, turnAbort.signal)
    } catch (err) {
      if (!(err instanceof Aborted)) throw err
      interrupted = true
      await runSteps(script.onInterrupt ?? defaultInterruptSteps(), null)
    } finally {
      turnRunning = false
      openToolUses.clear()
    }
    if (acks) await lifecycle(uuid, interrupted ? 'cancelled' : 'completed')
  }
  exit(script.exitCodeOnStdinEnd ?? 0)
}

main().catch((err) => {
  log('error', { message: String(err?.stack ?? err) })
  process.stderr.write(`fake-claude: ${String(err?.message ?? err)}\n`)
  exit(1)
})

// --- helpers ------------------------------------------------------------------

function log(kind, data) {
  try {
    fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now() - t0, kind, ...data })}\n`)
  } catch {
    // The state dir is gone (test torn down) — nothing left to record into.
  }
}

function readCurrentEpoch() {
  try {
    return fs.readFileSync(path.join(stateDir, 'current'), 'utf8').trim() || null
  } catch {
    return null
  }
}

/** The lowest unclaimed spawn index of this epoch. mkdir is atomic: one winner each. */
function claimIndex(dir) {
  fs.mkdirSync(path.join(dir, 'procs'), { recursive: true })
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(path.join(dir, 'procs', String(i)))
      return i
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
    }
  }
}

function hasFlag(flag) {
  const at = argv.indexOf(flag[0])
  if (at < 0) return false
  return flag.length === 1 || argv[at + 1] === flag[1]
}

function flagValue(name) {
  const at = argv.indexOf(name)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined
}
