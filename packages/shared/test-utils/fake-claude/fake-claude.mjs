// Scripted stand-in for the `claude` CLI in the stream-json mode chat spawns it in
// (`claude-code-adapter.ts`). Plays the scenario the test wrote into the state dir
// and records everything it receives. Zero dependencies, plain ESM, so it starts
// under any Node (or Electron as Node) without a build step. How to write a
// scenario: README.md next to this file. Types: scenario.ts.
//
// Run through the wrapper `createFakeClaude()` generates (bin/claude), which bakes
// in FAKE_CLAUDE_STATE_DIR — the app passes nothing to the fake but argv + stdin,
// exactly as it does to the real CLI.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createTaskSim } from './fake-claude-tasks.mjs'

/** What `--version` reports: the real CLI the transcripts were recorded with. */
export const FAKE_CLAUDE_VERSION = '2.1.312'

/** Flags SlayZone's chat transport always passes. Missing one = adapter drift. */
const REQUIRED_FLAGS = [
  ['-p'],
  ['--input-format', 'stream-json'],
  ['--output-format', 'stream-json'],
  ['--verbose'],
  ['--permission-prompt-tool', 'stdio'],
  ['--replay-user-messages'],
  ['--include-partial-messages']
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

/** Env the app is expected to set for the CLI, recorded so a test can check it. */
const LOGGED_ENV = ['CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CONFIG_DIR']

// `start` is logged once the signal handlers are installed (below), so a test that
// waits for it and then signals the process never races the default action.
let started = false
function logStart(extra = {}) {
  if (started) return
  started = true
  const env = {}
  for (const key of LOGGED_ENV) if (process.env[key] !== undefined) env[key] = process.env[key]
  log('start', {
    argv,
    cwd: process.cwd(),
    pid: process.pid,
    epoch,
    index,
    env,
    // Wall clock, so a test can order spawns of different processes.
    at: Date.now(),
    // Earlier spawns of this epoch still alive right now ("never two processes on
    // one conversation" is checked from here).
    peersAlive: peersAlive(),
    ...extra
  })
}

const script =
  scenario?.processes?.[index] ??
  (scenario?.repeatLast && scenario.processes?.length ? scenario.processes.at(-1) : undefined)

if (script?.tui) await runTui()

const missing = REQUIRED_FLAGS.filter((flag) => !hasFlag(flag))
if (missing.length > 0) {
  const text = `fake-claude: adapter argv drift — missing ${missing.map((f) => f.join(' ')).join(', ')}\n`
  logStart()
  log('argv-drift', { missing })
  process.stderr.write(text)
  process.exit(EXIT_ARGV_DRIFT)
}

if (!script) {
  const text = `fake-claude: no script for spawn #${index} (epoch ${epoch ?? 'none'})\n`
  logStart()
  log('unscripted', { index })
  process.stderr.write(text)
  process.exit(EXIT_UNSCRIPTED)
}

// --- template context ---------------------------------------------------------

const resumeId = flagValue('--resume')
// `--resume S --fork-session` runs a NEW conversation (`--session-id` names it,
// else a fresh id) holding S's history; S itself is never written (2.1.312).
const forking = resumeId !== undefined && argv.includes('--fork-session')
const ctx = {
  sessionId: forking
    ? (flagValue('--session-id') ?? randomUUID())
    : (resumeId ?? flagValue('--session-id') ?? ''),
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
  /** The slash command the real CLI would run for the current message ('' = none). */
  command: '',
  turn: 0,
  spawn: index
}

// --- the conversation + its session file ---------------------------------------
//
// The conversation as the CLI keeps it: the active branch of main-chain records
// (user messages, assistant blocks, tool results). It lives in the session file
// `<CLAUDE_CONFIG_DIR>/projects/<encoded cwd>/<sessionId>.jsonl` — written ONLY
// when CLAUDE_CONFIG_DIR is set, so a test never touches the real ~/.claude.
// Like the real file it is append-only: a rewind does not rewrite a line, the next
// record just points its `parentUuid` at an earlier one (a new branch).

const configDir = process.env.CLAUDE_CONFIG_DIR || null

function sessionFile(id) {
  if (!configDir || !id) return null
  return path.join(
    configDir,
    'projects',
    process.cwd().replace(/[^a-zA-Z0-9]/g, '-'),
    `${id}.jsonl`
  )
}

/** Main-chain records of the active branch, oldest first. */
const chain = []
/** user message uuid → the 0-based index of this process's user messages (rewind_files). */
const userIndexByUuid = new Map()
let userMessageCount = 0

/**
 * The active branch of a session file: from its last main-chain user/assistant
 * record back through `parentUuid` (every record kind counts as a link), cut after
 * `at` when given. Null when the file does not exist.
 */
function readActiveBranch(id, at) {
  const file = sessionFile(id)
  if (!file || !fs.existsSync(file)) return null
  const records = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
  const byUuid = new Map(records.filter((r) => r.uuid).map((r) => [r.uuid, r]))
  const leaf = records.findLast(
    (r) => (r.type === 'user' || r.type === 'assistant') && r.isSidechain !== true
  )
  const out = []
  const seen = new Set()
  for (let r = leaf; r && !seen.has(r.uuid); r = byUuid.get(r.parentUuid)) {
    seen.add(r.uuid)
    out.unshift(r)
  }
  if (at === undefined) return out
  const cut = out.findIndex((r) => r.uuid === at)
  return cut < 0 ? { missing: at } : out.slice(0, cut + 1)
}

/** A fork whose copied history is not in its file yet (see the `--resume` seeding). */
let forkUnwritten = false
/** Every record uuid this conversation holds (its file's, and this process's). */
const recordUuids = new Set()

function appendRecord(record) {
  const full = {
    parentUuid: chain.at(-1)?.uuid ?? null,
    isSidechain: false,
    sessionId: ctx.sessionId,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
    ...record
  }
  chain.push(full)
  const file = sessionFile(ctx.sessionId)
  if (!file) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines = forkUnwritten ? chain : [full]
  forkUnwritten = false
  fs.appendFileSync(file, lines.map((r) => `${JSON.stringify(r)}\n`).join(''))
}

/**
 * Every user message uuid this conversation has seen — its session file's whole
 * history (rewound branches included) plus this process's messages. The real CLI
 * drops a message whose uuid it has seen (chat-a check R2b): it acks it
 * `completed` at once and runs no turn.
 */
const seenUserUuids = new Set()

/** A user message joins the conversation (its turn starts). */
function recordUserMessage(entry) {
  const uuid = entry.uuid ?? randomUUID()
  seenUserUuids.add(uuid)
  userIndexByUuid.set(uuid, userMessageCount++)
  appendRecord({
    type: 'user',
    uuid,
    message: { role: 'user', content: entry.content ?? entry.text }
  })
}

/** Emitted main-chain events join the conversation too. */
function recordEmitted(event) {
  if (event?.parent_tool_use_id) return
  if (event?.type === 'assistant' && event.message) {
    appendRecord({ type: 'assistant', uuid: event.uuid ?? randomUUID(), message: event.message })
  } else if (event?.type === 'user' && event.message && event.isReplay !== true) {
    appendRecord({ type: 'user', uuid: event.uuid ?? randomUUID(), message: event.message })
  }
}

function userText(record) {
  const c = record.message?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c) || c[0]?.type === 'tool_result') return null
  return c.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
}

/** `rewind_conversation`: drop the user message and everything after it (live, 2.1.312). */
function rewindConversation(target) {
  const at = chain.findIndex((r) => r.type === 'user' && r.uuid === target && userText(r) !== null)
  if (at < 0) {
    return {
      rewound: false,
      prefillText: null,
      precedingAssistantUuid: null,
      error: 'target not found',
      reason: 'target_not_found'
    }
  }
  const prefillText = userText(chain[at])
  const preceding = chain.slice(0, at).findLast((r) => r.type === 'assistant')
  chain.length = at
  log('rewound', { target })
  return {
    rewound: true,
    targetMessageUuid: target,
    prefillText,
    precedingAssistantUuid: preceding?.uuid ?? null
  }
}

/** `rewind_files`: the scenario's checkpoint for that message (spike item 5 shapes). */
function rewindFiles(userMessageId, dryRun) {
  if (process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING !== 'true') {
    return { canRewind: false, error: 'File rewinding is not enabled.' }
  }
  const at = userIndexByUuid.get(userMessageId)
  const checkpoint = at === undefined ? undefined : script.fileCheckpoints?.[String(at)]
  if (!checkpoint) return { canRewind: false, error: 'No file checkpoint found for this message.' }
  if (dryRun) {
    return {
      canRewind: true,
      filesChanged: checkpoint.filesChanged.map((f) => path.resolve(process.cwd(), f)),
      insertions: checkpoint.insertions,
      deletions: checkpoint.deletions
    }
  }
  for (const [rel, content] of Object.entries(checkpoint.restore ?? {})) {
    const file = path.resolve(process.cwd(), rel)
    if (content === null) fs.rmSync(file, { force: true })
    else fs.writeFileSync(file, content)
  }
  log('files-rewound', { userMessageId })
  return { canRewind: true, skippedLinks: 0 }
}

// Seed from the resumed session (cut at `--resume-session-at`); a fork copies
// that history into its own new file.
if (resumeId !== undefined) {
  const at = flagValue('--resume-session-at')
  const seeded = readActiveBranch(resumeId, at)
  if (seeded && !Array.isArray(seeded)) {
    logStart()
    process.stderr.write(`No message found with message.uuid of: ${seeded.missing}\n`)
    log('exit', { code: 1 })
    process.exit(1)
  }
  const file = sessionFile(resumeId)
  if (file && fs.existsSync(file)) {
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!l.trim()) continue
      const r = JSON.parse(l)
      if (r.type === 'user' && typeof r.uuid === 'string') seenUserUuids.add(r.uuid)
      if (typeof r.uuid === 'string') recordUuids.add(r.uuid)
    }
  }
  for (const record of seeded ?? []) {
    if (typeof record.uuid === 'string') recordUuids.add(record.uuid)
    chain.push(
      forking
        ? { ...record, sessionId: ctx.sessionId, parentUuid: chain.at(-1)?.uuid ?? null }
        : record
    )
  }
  // A fork copies that history into its own file with its first record, not at
  // startup (2.1.312, chat-a check R3b): an unused fork leaves no file.
  forkUnwritten = forking
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
    if (uuid && (seenUserUuids.has(uuid) || userQueue.some((e) => e.uuid === uuid))) {
      log('duplicate-user-uuid', { uuid })
      if (acksDelivery()) void lifecycle(uuid, 'completed')
      return
    }
    const entry = { text, uuid, content }
    // A delayed message's acks wait until its turn takes it (main()).
    if (uuid && acksDelivery() && !ackDelayed(userMessageCount + userQueue.length)) {
      void lifecycle(uuid, 'queued')
    }
    if (userWaiter) {
      const w = userWaiter
      userWaiter = null
      w(entry)
    } else userQueue.push(entry)
  }
}

/**
 * The command Claude Code runs for a user message: its typed input is the LAST
 * block (verified on 2.1.312: `[image, text '/x a']` runs /x; `[text '/x a',
 * image]` goes to the model as plain text).
 */
function slashCommandOf(content) {
  const last = Array.isArray(content) ? content[content.length - 1] : null
  const typed = typeof content === 'string' ? content : last?.type === 'text' ? last.text : ''
  const m = /^\/(\S+)/.exec(String(typed ?? '').trim())
  return m ? m[1] : ''
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
  if (mode === 'error' || (typeof mode === 'object' && 'error' in mode)) {
    await writeLine({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: msg.request_id,
        error: typeof mode === 'object' ? mode.error : `fake-claude: ${subtype} refused by scenario`
      }
    })
    return
  }
  if (await taskSim.onControl(msg)) return
  // Reply payloads as the real CLI sends them (recorded: control-requests,
  // interrupt-* transcripts, chat-a real-CLI checks).
  let payload = {}
  if (subtype === 'set_model' && typeof msg.request.model === 'string') {
    ctx.model = msg.request.model
    payload = { model: ctx.model }
  }
  if (subtype === 'set_permission_mode' && typeof msg.request.mode === 'string') {
    ctx.permissionMode = msg.request.mode
    payload = { mode: ctx.permissionMode }
  }
  if (subtype === 'apply_flag_settings') {
    const settings = msg.request.settings ?? {}
    if ('effortLevel' in settings) ctx.effort = settings.effortLevel ?? ''
    // 2.1.312 acks it with no `response` body at all.
    payload = undefined
  }
  if (subtype === 'rewind_conversation')
    payload = rewindConversation(msg.request.target_message_uuid)
  if (subtype === 'rewind_files') {
    payload = rewindFiles(msg.request.user_message_id, msg.request.dry_run === true)
  }
  if (subtype === 'cancel_async_message') {
    const at = userQueue.findIndex((e) => e.uuid === msg.request.message_uuid)
    if (at >= 0) {
      const [entry] = userQueue.splice(at, 1)
      if (acksDelivery()) await lifecycle(entry.uuid, 'cancelled')
    }
    payload = { cancelled: at >= 0 }
  }
  if (subtype === 'interrupt') {
    // Messages that arrived mid-turn: the CLI still runs them after the interrupt.
    payload = { still_queued: userQueue.map((e) => e.uuid).filter(Boolean) }
    // Like 2.1.312: pending prompts are withdrawn (control_cancel_request) BEFORE
    // the interrupt is acknowledged; the turn's end follows the ack.
    if (turnRunning && turnAbort) {
      log('interrupt', { turn: ctx.turn })
      turnAbort.abort()
    }
  }
  // The reply always carries commands[] (each with description + argumentHint).
  if (subtype === 'initialize') payload = { commands: [] }
  const scripted = script.controlPayloads?.[subtype]
  if (scripted) payload = { ...payload, ...scripted }
  if (typeof mode === 'object' && 'success' in mode) payload = mode.success
  await writeLine({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: msg.request_id,
      ...(payload === undefined ? {} : { response: payload })
    }
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

/** Command tasks (`task` step + task control requests): fake-claude-tasks.mjs. */
const taskSim = createTaskSim({ emit, writeLine, sleep, log, runSteps, Aborted })

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
  // Like the CLI: every assistant line carries the uuid of its session record,
  // and no two records share one — a scripted uuid played again (a reused
  // `defaultTurn`, a resumed conversation) gets a new one.
  if (event?.type === 'assistant' && event.message) {
    if (typeof event.uuid !== 'string' || recordUuids.has(event.uuid)) event.uuid = randomUUID()
    recordUuids.add(event.uuid)
  }
  trackTools(event)
  recordEmitted(event)
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
  recordEmitted(event)
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
    else if ('task' in step) await taskSim.run(step.task, signal)
    else if ('parallel' in step) {
      // Branches run at once (parallel tool calls each asking for permission).
      await Promise.all(step.parallel.map((branch) => runSteps(branch, signal)))
    } else throw new Error(`fake-claude: unknown step ${JSON.stringify(step)}`)
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
    recordUserMessage(message)
    ctx.command = slashCommandOf(content)
    const acks = Boolean(uuid) && acksDelivery()
    if (acks && ackDelayed(userMessageCount - 1)) {
      // The CLI has the message (it is in the conversation) but says so late.
      await sleep(script.ackDelayMs, null)
      await lifecycle(uuid, 'queued')
    }
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

/** Are the acks of this process's `index`-th user message held back (`ackDelayMs`)? */
function ackDelayed(index) {
  return Boolean(script.ackDelayMs) && index >= (script.ackDelayFrom ?? 0)
}

/** Earlier spawns of this epoch whose process is still alive (by their logged pid). */
function peersAlive() {
  if (!epochDir) return []
  const alive = []
  for (let i = 0; i < index; i++) {
    let pid
    try {
      const first = fs
        .readFileSync(path.join(epochDir, 'procs', String(i), 'log.jsonl'), 'utf8')
        .split('\n')
        .find((l) => l.includes('"kind":"start"'))
      pid = first ? JSON.parse(first).pid : undefined
    } catch {
      continue
    }
    if (typeof pid !== 'number') continue
    try {
      process.kill(pid, 0)
      alive.push(i)
    } catch {
      // gone
    }
  }
  return alive
}

/**
 * The interactive TUI (`claude` without `-p`), as far as the app can see it from
 * outside: a process in a pty that resumes or starts a conversation and runs
 * until it is stopped. Never returns.
 */
async function runTui() {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      log('signal', { signal })
      log('exit', { code: signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 129 })
      process.exit(signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 129)
    })
  }
  const id = flagValue('--resume') ?? flagValue('--session-id') ?? '?'
  logStart({ tui: true })
  process.stdout.write(`fake-claude TUI · session ${id}\r\n> `)
  setInterval(() => undefined, 1 << 30)
  await new Promise(() => undefined)
}
