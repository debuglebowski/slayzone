// Scripted stand-in for `codex app-server`, the JSON-RPC-over-stdio server Codex
// chat spawns (`codex-chat-session.ts`). Plays the scenario the test wrote into
// the state dir and records everything it receives. Zero dependencies, plain
// ESM. How to write a scenario: README.md next to this file. Types: scenario.ts.
//
// Defaults copy codex-cli 0.159.2 as recorded (transcripts/*.jsonl): responses
// carry no `jsonrpc` field, `turn/start` is answered at once and the turn streams
// as notifications, server→client request ids count from 0, an answered request
// is followed by `serverRequest/resolved`, stdin closing or SIGTERM ends the
// process at once with exit 0 and nothing more on stdout.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Aborted, claimSpawn, EXIT_UNSCRIPTED, readLines, sleep } from '../fake-cli/runtime.mjs'

/** What `--version` reports: the CLI the transcripts were recorded with. */
export const FAKE_CODEX_VERSION = '0.159.2'

const EXIT_ARGV_DRIFT = 2

const argv = process.argv.slice(2)
if (argv.includes('--version') || argv.includes('-V')) {
  process.stdout.write(`codex-cli ${FAKE_CODEX_VERSION}\n`)
  process.exit(0)
}

const { stateDir, epoch, index, script, log, peersAlive } = claimSpawn({
  stateEnvVar: 'FAKE_CODEX_STATE_DIR',
  label: 'fake-codex'
})
const scenario = epoch
  ? JSON.parse(fs.readFileSync(path.join(stateDir, 'epochs', epoch, 'scenario.json'), 'utf8'))
  : null

function logStart() {
  log('start', {
    argv,
    cwd: process.cwd(),
    pid: process.pid,
    epoch,
    index,
    at: Date.now(),
    peersAlive: peersAlive()
  })
}

// Chat spawns `codex app-server` (any `-c key=value` after it is fine).
if (argv[0] !== 'app-server') {
  logStart()
  log('argv-drift', { argv })
  process.stderr.write(
    `fake-codex: adapter argv drift — expected 'app-server', got ${JSON.stringify(argv)}\n`
  )
  process.exit(EXIT_ARGV_DRIFT)
}
if (!script) {
  logStart()
  log('unscripted', { index })
  process.stderr.write(`fake-codex: no script for spawn #${index} (epoch ${epoch ?? 'none'})\n`)
  process.exit(EXIT_UNSCRIPTED)
}

// --- state ----------------------------------------------------------------------

const threadsDir = path.join(stateDir, 'threads')
const ctx = {
  threadId: '',
  turnId: '',
  cwd: process.cwd(),
  model: 'gpt-6-luna',
  userText: '',
  turn: 0,
  spawn: index
}
let nextServerRequestId = 0
/** Server→client requests awaiting the app's reply: id → { method, resolve }. */
const pendingRequests = new Map()
/** Requests a turn's interrupt left unanswered: resolved after its `turn/completed`. */
let abandonedRequests = []
const turnQueue = []
let turnRunning = false
let turnAbort = null
let exiting = false

// --- signals + stdin ------------------------------------------------------------

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    log('signal', { signal })
    if (script.onSigterm && signal === 'SIGTERM') {
      runSteps(script.onSigterm, null)
        .catch(() => undefined)
        .finally(() => exit(script.sigtermExitCode ?? 0))
      return
    }
    // codex-cli 0.159.2 (recipe sigterm-mid-turn): nothing more, exit 0.
    exit(script.sigtermExitCode ?? 0)
  })
}

logStart()

process.stdout.on('error', (err) => {
  log('stdout-error', { message: String(err) })
  process.exit(0)
})

readLines(process.stdin, onStdinLine, () => {
  log('stdin-end', {})
  // Recipe stdin-close-mid-turn: the CLI exits at once, even mid-turn.
  if (script.onStdinEnd === 'stay') return
  exit(script.exitCodeOnStdinEnd ?? 0)
})

await runSteps(script.onStart ?? [], null).catch((err) => fail(err))

// --- JSON-RPC in ----------------------------------------------------------------

function onStdinLine(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    log('stdin-raw', { line })
    return
  }
  log('rpc-in', { msg })
  const hasId = msg.id !== undefined && msg.id !== null
  if (hasId && typeof msg.method !== 'string') return void onReply(msg)
  if (typeof msg.method !== 'string') return
  if (!hasId) return // client notification (`initialized`, …): logged only
  void onRequest(msg).catch((err) => fail(err))
}

function onReply(msg) {
  const pending = pendingRequests.get(msg.id)
  if (!pending) {
    log('late-reply', { requestId: msg.id, msg })
    return
  }
  pendingRequests.delete(msg.id)
  pending.resolve(msg)
}

async function onRequest(msg) {
  const { id, method, params } = msg
  const override = script.methods?.[method]
  switch (method) {
    case 'initialize':
      return respondWith(id, script.handshake?.initialize, () => ({
        userAgent: `slayzone/${FAKE_CODEX_VERSION} (Mac OS 26.5.2; arm64) fake (slayzone; 1.0)`,
        codexHome: '/Users/user/.codex',
        platformFamily: 'unix',
        platformOs: 'macos'
      }))
    case 'thread/start':
      return respondWith(id, script.handshake?.threadStart, () => {
        ctx.threadId = randomUUID()
        ctx.cwd = params?.cwd ?? ctx.cwd
        if (params?.model) ctx.model = params.model
        saveThread(ctx.threadId)
        return threadResponse(params)
      }).then((ok) => {
        if (ok) return emit({ method: 'thread/started', params: { thread: threadObject() } })
      })
    case 'thread/resume':
      return respondWith(id, script.handshake?.threadResume, () => {
        const wanted = params?.threadId
        if (!isKnownThread(wanted)) {
          // codex-cli 0.159.2, recipe resume-missing.
          return { error: { code: -32600, message: `no rollout found for thread id ${wanted}` } }
        }
        ctx.threadId = wanted
        ctx.cwd = params?.cwd ?? ctx.cwd
        return threadResponse(params)
      })
    case 'turn/start':
      return startTurn(id, params)
    case 'turn/interrupt':
      return interrupt(id, params)
    default:
      if (override !== undefined) return respondWith(id, override, () => ({}))
      log('unknown-method', { method })
      return writeMessage({ id, error: { code: -32601, message: `method not found: ${method}` } })
  }
}

/**
 * Answer a request: `spec` unset → `ok()`'s result; `{error}` → that error;
 * `{hang: true}` → never; `{delayMs}` → later. Resolves true when it succeeded.
 */
async function respondWith(id, spec, ok) {
  if (spec?.delayMs) await sleep(spec.delayMs, null)
  if (spec?.hang) {
    log('hang-request', { id })
    return false
  }
  if (spec?.error) {
    await writeMessage({ id, error: substitute(spec.error) })
    return false
  }
  const result = spec?.result !== undefined ? substitute(spec.result) : ok()
  if (result?.error) {
    await writeMessage({ id, error: result.error })
    return false
  }
  await writeMessage({ id, result })
  return true
}

function threadObject() {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: ctx.threadId,
    sessionId: ctx.threadId,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    modelProvider: 'openai',
    model: ctx.model,
    createdAt: now,
    updatedAt: now,
    status: { type: 'idle' },
    path: null,
    cwd: ctx.cwd,
    cliVersion: FAKE_CODEX_VERSION,
    source: 'vscode',
    turns: []
  }
}

function threadResponse(params) {
  return {
    thread: threadObject(),
    model: ctx.model,
    modelProvider: 'openai',
    serviceTier: null,
    cwd: ctx.cwd,
    approvalPolicy: params?.approvalPolicy ?? 'on-request',
    approvalsReviewer: 'user',
    sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
    reasoningEffort: 'medium'
  }
}

function saveThread(id) {
  fs.mkdirSync(threadsDir, { recursive: true })
  fs.writeFileSync(
    path.join(threadsDir, `${id}.json`),
    JSON.stringify({ cwd: ctx.cwd, spawn: index })
  )
}

function isKnownThread(id) {
  if (typeof id !== 'string' || !id) return false
  if ((scenario?.threads ?? []).includes(id)) return true
  return fs.existsSync(path.join(threadsDir, `${id}.json`))
}

// --- turns ----------------------------------------------------------------------

async function startTurn(id, params) {
  const turnId = randomUUID()
  const text = (params?.input ?? [])
    .map((b) => (typeof b?.text === 'string' ? b.text : ''))
    .join('')
  const spec = script.turnStart ?? {}
  // The reply AND `turn/started` carry the turn id; holding both back opens the
  // window where the app has a running turn it cannot name (Stop before an id).
  const reply = async () => {
    if (spec.replyDelayMs) await sleep(spec.replyDelayMs, null)
    if (spec.error) {
      await writeMessage({ id, error: substitute(spec.error) })
      return false
    }
    await writeMessage({ id, result: { turn: turnObject(turnId, 'inProgress') } })
    return true
  }
  turnQueue.push({ turnId, text, params, reply })
  if (turnRunning) log('turn-start-while-running', { turnId })
  if (!turnRunning) void drainTurns().catch((err) => fail(err))
}

async function drainTurns() {
  turnRunning = true
  while (turnQueue.length > 0) {
    const next = turnQueue.shift()
    const ok = await next.reply()
    if (ok) await runTurn(next)
  }
  turnRunning = false
}

function turnObject(turnId, status, extra = {}) {
  return {
    id: turnId,
    items: [],
    itemsView: 'notLoaded',
    status,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...extra
  }
}

async function runTurn(turn) {
  const started = Date.now()
  ctx.turnId = turn.turnId
  ctx.userText = turn.text
  if (turn.params?.model) ctx.model = turn.params.model
  const turnIndex = ctx.turn
  ctx.turn += 1
  log('turn', { turn: turnIndex, turnId: turn.turnId, text: turn.text })
  const steps = script.turns?.[turnIndex] ?? script.defaultTurn
  if (!steps) {
    log('unscripted-turn', { turn: turnIndex, text: turn.text })
    await emit(turnStartedEvent())
    const message = `fake-codex: no script for turn #${turnIndex}`
    await emit({
      method: 'error',
      params: {
        error: { message },
        willRetry: false,
        threadId: '{{threadId}}',
        turnId: '{{turnId}}'
      }
    })
    await emit(turnCompletedEvent('failed', started, { message }))
    return
  }
  const scripted = steps.some((s) => s.replay) || script.autoTurnEvents === false
  turnAbort = new AbortController()
  const state = { ended: false }
  try {
    if (!scripted) {
      await emit({
        method: 'thread/status/changed',
        params: { threadId: '{{threadId}}', status: { type: 'active', activeFlags: [] } }
      })
      await emit(turnStartedEvent())
    }
    await runSteps(steps, turnAbort.signal, state)
    if (!scripted && !state.ended) {
      await emit({
        method: 'thread/status/changed',
        params: { threadId: '{{threadId}}', status: { type: 'idle' } }
      })
      await emit(turnCompletedEvent('completed', started))
    }
  } catch (err) {
    if (!(err instanceof Aborted)) throw err
    log('turn-interrupted', { turnId: turn.turnId })
    if (script.onInterrupt) await runSteps(script.onInterrupt, null)
    else {
      // codex-cli 0.159.2 (recipes interrupt-command, approval-interrupt): idle,
      // `turn/completed {interrupted}` — no `item/completed` for a running item —
      // then `serverRequest/resolved` for every request left unanswered.
      await emit({
        method: 'thread/status/changed',
        params: { threadId: '{{threadId}}', status: { type: 'idle' } }
      })
      await emit(turnCompletedEvent('interrupted', started))
    }
    for (const requestId of abandonedRequests) {
      await emit({
        method: 'serverRequest/resolved',
        params: { threadId: '{{threadId}}', requestId }
      })
    }
    abandonedRequests = []
  } finally {
    turnAbort = null
  }
}

function turnStartedEvent() {
  return {
    method: 'turn/started',
    params: {
      threadId: '{{threadId}}',
      turn: turnObject(ctx.turnId, 'inProgress', { startedAt: Math.floor(Date.now() / 1000) })
    }
  }
}

function turnCompletedEvent(status, started, error = null) {
  return {
    method: 'turn/completed',
    params: {
      threadId: '{{threadId}}',
      turn: turnObject(ctx.turnId, status, {
        itemsView: 'summary',
        error,
        startedAt: Math.floor(started / 1000),
        completedAt: Math.floor(Date.now() / 1000),
        durationMs: Date.now() - started
      })
    }
  }
}

async function interrupt(id, params) {
  log('interrupt', { turnId: params?.turnId ?? null, current: ctx.turnId || null })
  if (script.interrupt === 'ignore') return
  if (script.interrupt === 'error') {
    return writeMessage({ id, error: { code: -32600, message: 'interrupt refused (scripted)' } })
  }
  if (typeof params?.turnId !== 'string') {
    // `turnId` is required (protocol-surface.json `turn/interrupt`).
    return writeMessage({
      id,
      error: { code: -32600, message: 'Invalid request: missing field `turnId`' }
    })
  }
  await writeMessage({ id, result: {} })
  if (turnAbort && params.turnId === ctx.turnId) turnAbort.abort()
}

// --- steps ----------------------------------------------------------------------

async function runSteps(steps, signal, state = { ended: false }) {
  for (const s of steps) {
    if (signal?.aborted) throw new Aborted()
    if (s.emit !== undefined) {
      for (const event of Array.isArray(s.emit) ? s.emit : [s.emit]) {
        await emit(event)
        if (s.gapMs) await sleep(s.gapMs, signal)
      }
    } else if (s.emitRaw !== undefined) {
      await writeRaw(s.emitRaw)
    } else if (s.stderr !== undefined) {
      process.stderr.write(substitute(s.stderr))
      log('stderr', { text: s.stderr })
    } else if (s.sleep !== undefined) {
      await sleep(s.sleep, signal)
    } else if (s.hang) {
      await new Promise((_, reject) => {
        if (!signal) return
        signal.addEventListener('abort', () => reject(new Aborted()))
      })
    } else if (s.exit !== undefined) {
      if (s.signal) {
        log('exit', { signal: s.signal })
        process.kill(process.pid, s.signal)
        await new Promise(() => undefined)
      }
      exit(s.exit)
      await new Promise(() => undefined)
    } else if (s.request) {
      await serverRequest(s, signal, state)
    } else if (s.endTurn) {
      state.ended = true
      await emit({
        method: 'thread/status/changed',
        params: { threadId: '{{threadId}}', status: { type: 'idle' } }
      })
      await emit(turnCompletedEvent(s.endTurn.status, Date.now(), s.endTurn.error ?? null))
    } else if (s.replay) {
      await replay(s.replay, signal)
      state.ended = true
    } else {
      throw new Error(`fake-codex: unknown step ${JSON.stringify(s)}`)
    }
  }
}

/** Send a server→client request (an approval) and wait for the app's reply. */
async function serverRequest(s, signal, state) {
  const reply = await ask(s.request.method, substitute(s.request.params ?? {}), signal)
  const decision = decisionOf(reply)
  const branch =
    s.branches?.[decision] ?? (reply.error ? s.branches?.error : undefined) ?? s.branches?.default
  if (branch) await runSteps(branch, signal, state)
}

/** Key of a reply's decision: `accept`, `acceptForSession`, an object variant's key, or `error`. */
function decisionOf(reply) {
  if (reply.error) return 'error'
  const d = reply.result?.decision
  if (typeof d === 'string') return d
  if (d && typeof d === 'object') return Object.keys(d)[0] ?? 'unknown'
  if (reply.result?.action) return reply.result.action // elicitation
  return 'unknown'
}

function ask(method, params, signal) {
  const id = nextServerRequestId++
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, {
      method,
      resolve: (msg) => {
        log('request-reply', {
          requestId: id,
          method,
          decision: decisionOf(msg),
          reply: msg.error ? { error: msg.error } : msg.result
        })
        // codex-cli 0.159.2: an answered request is resolved at once.
        void emit({
          method: 'serverRequest/resolved',
          params: { threadId: '{{threadId}}', requestId: id }
        }).then(() => resolve(msg))
      }
    })
    signal?.addEventListener('abort', () => {
      if (!pendingRequests.has(id)) return
      pendingRequests.delete(id)
      abandonedRequests.push(id)
      log('request-abandoned', { requestId: id, method })
      reject(new Aborted())
    })
    log('request', { requestId: id, method, params })
    void writeMessage({ id, method, params })
  })
}

/**
 * Replay one recorded turn: the server lines between that turn's `turn/start`
 * and the next one (its `turn/completed` included). Responses to the recorder's
 * own requests are skipped — the fake answered this turn/start itself. A recorded
 * server request blocks until the app answers it, under a fresh id.
 */
async function replay(spec, signal) {
  const records = fs
    .readFileSync(spec.transcript, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
  const wantProcess = spec.process ?? 0
  const wantTurn = spec.turn ?? 0
  let proc = -1
  let turn = -1
  let lastT = null
  const ids = new Map()
  const speed = spec.speed ?? 0
  for (const r of records) {
    if (r.kind === 'process') {
      proc = r.index
      turn = -1
      continue
    }
    if (proc !== wantProcess) continue
    if (r.kind === 'stdin') {
      const m = JSON.parse(r.line)
      if (m.method === 'turn/start') turn += 1
      continue
    }
    if (r.kind !== 'stdout' || turn !== wantTurn) continue
    const m = JSON.parse(r.line)
    if (m.id !== undefined && typeof m.method !== 'string') continue
    if (speed > 0 && lastT !== null) await sleep((r.t - lastT) / speed, signal)
    lastT = r.t
    if (m.id !== undefined) {
      const reply = await ask(m.method, substitute(m.params ?? {}), signal)
      ids.set(m.id, null)
      const recorded = recordedReply(records, wantProcess, m.id)
      const got = decisionOf(reply)
      if (recorded !== undefined && recorded !== got) {
        log('replay-mismatch', { requestId: m.id, recorded, got })
      }
      continue
    }
    // `ask` already resolved the replayed request under its own id.
    if (m.method === 'serverRequest/resolved' && ids.has(m.params?.requestId)) continue
    await emit(m)
    if (m.method === 'turn/completed') break
  }
}

function recordedReply(records, wantProcess, requestId) {
  let proc = -1
  for (const r of records) {
    if (r.kind === 'process') proc = r.index
    if (proc !== wantProcess || r.kind !== 'stdin') continue
    const m = JSON.parse(r.line)
    if (m.id === requestId && m.method === undefined) return decisionOf(m)
  }
  return undefined
}

// --- output ---------------------------------------------------------------------

function substitute(value) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (all, key) => (key in ctx ? String(ctx[key]) : all))
  }
  if (Array.isArray(value)) return value.map(substitute)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]))
  }
  return value
}

function emit(event) {
  return writeMessage(substitute(event))
}

function writeMessage(msg) {
  return writeRaw(JSON.stringify(msg))
}

function writeRaw(line) {
  return new Promise((resolve) => {
    process.stdout.write(`${line}\n`, () => {
      log('stdout', { line })
      resolve()
    })
  })
}

function exit(code) {
  if (exiting) return
  exiting = true
  log('exit', { code })
  process.exit(code)
}

function fail(err) {
  log('error', { message: String(err?.stack ?? err) })
  process.stderr.write(`fake-codex: ${String(err?.message ?? err)}\n`)
  exit(1)
}
