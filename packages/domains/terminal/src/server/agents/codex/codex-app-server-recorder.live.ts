/**
 * Records REAL `codex app-server` runs as transcripts — the fixtures the fake
 * (`@slayzone/test-utils/fake-codex`) replays and the protocol drift check
 * (codex-protocol-drift.test.ts) reads. Format: test-utils/fake-cli/transcript.ts.
 *
 * Opt-in (hits the OpenAI backend with the cheapest model, a few cents) — NOT
 * part of run-all.sh. Re-record after a CLI update, then run the drift check:
 *   npx tsx packages/domains/terminal/src/server/agents/codex/codex-app-server-recorder.live.ts [recipe…]
 *
 * Env:
 *  - `SLAYZONE_CODEX_BIN_PATH`: the `codex` to record (default: `codex` on PATH).
 *    Install a pinned version aside without touching the global one:
 *    `npm i --prefix <dir> @openai/codex@<version>` → `<dir>/node_modules/.bin/codex`.
 *  - `SLAYZONE_CODEX_RECORD_DIR`: the ONE work dir every recipe runs in (emptied
 *    before each; default `<tmpdir>/slz-codex-rec`). The CLI marks every cwd it
 *    starts a thread in as trusted in `~/.codex/config.toml` (a `[projects."…"]`
 *    entry, written by the CLI itself), so one fixed dir adds one entry, not one
 *    per recipe.
 *
 * Writes the same JSON-RPC the `CodexChatSession` driver writes (initialize,
 * thread/start|resume, turn/start with the driver's policy params). Settings go
 * through `-c` flags only: the user's `~/.codex/config.toml` and login are read,
 * never written by this script. Every SLAYZONE_* env var is stripped so the
 * user's agent hooks report nothing to the running app. Each recipe runs in a
 * fresh temp dir; the CLI still writes its own rollout files under
 * `~/.codex/sessions` (their `cwd` is that temp dir) — move them out after a
 * recording session. Every line is redacted before it is kept (paths, ids,
 * emails, account and rate-limit figures); review the diff anyway.
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { CODEX_TRANSCRIPTS_DIR, type TranscriptRecord } from '@slayzone/test-utils/fake-codex'

/**
 * The cheapest model `model/list` offers (codex-cli 0.159.2: "Fast and affordable
 * model for easier tasks"). Older CLIs list models a ChatGPT login may no longer
 * use: 0.139.0 offers gpt-5.5 … gpt-5.2, all refused at turn time (recipe
 * `model-refused` records that refusal).
 */
const MODEL = 'gpt-6-luna'
const CODEX_BIN = process.env.SLAYZONE_CODEX_BIN_PATH || 'codex'
const WORK_DIR = process.env.SLAYZONE_CODEX_RECORD_DIR || path.join(os.tmpdir(), 'slz-codex-rec')
const EFFORT = 'low'
const TURN_TIMEOUT_MS = 180_000
const CLIENT_INFO = { name: 'slayzone', title: 'SlayZone', version: '1.0' }

type Json = Record<string, unknown>

/** The driver's runtime-mode mapping (codex-chat-session.ts `mapRuntimePolicy`). */
type Policy = 'approval-required' | 'auto-accept-edits' | 'full-access'
function policyParams(policy: Policy, cwd: string) {
  switch (policy) {
    case 'approval-required':
      return {
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
        sandboxPolicy: { type: 'readOnly', networkAccess: false }
      }
    case 'full-access':
      return {
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        sandboxPolicy: { type: 'dangerFullAccess' }
      }
    case 'auto-accept-edits':
      return {
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        }
      }
  }
}

interface TurnSpec {
  say: string
  /** Reply to a server→client request. `null` leaves it unanswered. Default: accept. */
  answer?: (method: string, params: Json) => Json | null
  /** Send ONE `turn/interrupt` when this first matches a server line. */
  interruptWhen?: (msg: Json) => boolean
  /** SIGTERM the process when this first matches; the process ends there. */
  sigtermWhen?: (msg: Json) => boolean
  /** Close stdin when this first matches; the process ends there. */
  closeStdinWhen?: (msg: Json) => boolean
  model?: string
  effort?: string
}

interface ProcSpec {
  policy: Policy
  /** `previous`: thread/resume the previous process's thread. `missing`: a random id. */
  resume?: 'previous' | 'missing'
  turns: TurnSpec[]
  extraArgs?: (cwd: string) => string[]
}

interface Recipe {
  note: string
  setup?: (cwd: string) => void | Promise<void>
  processes: ProcSpec[]
}

const accept = () => ({ decision: 'accept' })
const isMethod =
  (method: string) =>
  (msg: Json): boolean =>
    msg.method === method
const itemStartedOf =
  (type: string) =>
  (msg: Json): boolean =>
    msg.method === 'item/started' &&
    (msg.params as { item?: { type?: string } })?.item?.type === type

/** Interrupt after the Nth agent-message delta (a turn cut mid-reply). */
function afterDeltas(n: number) {
  let seen = 0
  return (msg: Json): boolean => msg.method === 'item/agentMessage/delta' && ++seen === n
}

const MCP_ECHO_SERVER = `// Minimal MCP stdio server: one tool, echo.
import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} }, serverInfo: { name: 'slz_echo', version: '1.0.0' } } })
  } else if (msg.method === 'tools/list') {
    send({ id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo the given text back.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      annotations: { readOnlyHint: true } }] } })
  } else if (msg.method === 'tools/call') {
    send({ id: msg.id, result: { content: [{ type: 'text', text: 'echo: ' + (msg.params?.arguments?.text ?? '') }] } })
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'method not found' } })
  }
})
`

/** MCP servers whose names may stay in a recording; the user's own are renamed. */
const KNOWN_MCP_SERVERS = new Set(['codex_apps', 'slz_echo'])

const RECIPES: Record<string, Recipe> = {
  'simple-turn': {
    note: 'One short reply in auto-accept-edits, then stdin closed (the clean exit).',
    processes: [
      { policy: 'auto-accept-edits', turns: [{ say: 'Reply with exactly the word: OK' }] }
    ]
  },
  'stream-long': {
    note: 'A long streamed reply: one agentMessage item, many deltas (audit #5).',
    processes: [
      {
        policy: 'auto-accept-edits',
        turns: [{ say: 'Write the numbers one to sixty as words, one per line, nothing else.' }]
      }
    ]
  },
  reasoning: {
    note: 'Effort medium: a reasoning item before the answer.',
    processes: [
      {
        policy: 'auto-accept-edits',
        turns: [
          {
            say: 'Think it through, then answer: what is 17 times 23? Reply with only the number.',
            effort: 'medium'
          }
        ]
      }
    ]
  },
  'command-exec': {
    note: 'full-access: a command with live output (outputDelta), no approval.',
    processes: [
      {
        policy: 'full-access',
        turns: [
          {
            say: 'Run this exact shell command, then reply with only DONE: for i in 1 2 3; do echo line $i; sleep 1; done'
          }
        ]
      }
    ]
  },
  'file-change': {
    note: 'auto-accept-edits: apply_patch creates then edits a file (fileChange items, diffs).',
    setup: (cwd) => gitInit(cwd),
    processes: [
      {
        policy: 'auto-accept-edits',
        turns: [
          {
            say: 'Use apply_patch to create notes.txt containing the single line: hello world. Then reply with only DONE.'
          },
          {
            say: 'Use apply_patch to change the line in notes.txt to: hello codex. Then reply with only DONE.'
          }
        ]
      }
    ]
  },
  'approval-exec': {
    note: 'approval-required: command approvals answered accept, acceptForSession, then decline.',
    setup: (cwd) => gitInit(cwd),
    processes: [
      {
        policy: 'approval-required',
        turns: [
          {
            say: 'Run the shell command `touch a.txt`, then reply with only DONE.',
            answer: accept
          },
          {
            say: 'Run the shell command `touch b.txt`, then reply with only DONE.',
            answer: () => ({ decision: 'acceptForSession' })
          },
          {
            say: 'Run the shell command `touch b.txt` once more, then reply with only DONE.',
            answer: accept
          },
          {
            say: 'Run the shell command `touch c.txt`, then reply with only DONE.',
            answer: () => ({ decision: 'decline' })
          }
        ]
      }
    ]
  },
  'approval-file': {
    note: 'approval-required: file-change approvals answered accept, then decline.',
    setup: (cwd) => gitInit(cwd),
    processes: [
      {
        policy: 'approval-required',
        turns: [
          {
            say: 'Use apply_patch to create x.txt containing: one. Then reply with only DONE.',
            answer: accept
          },
          {
            say: 'Use apply_patch to create y.txt containing: two. Then reply with only DONE.',
            answer: () => ({ decision: 'decline' })
          }
        ]
      }
    ]
  },
  'approval-interrupt': {
    note: 'approval-required: a command approval left unanswered, then turn/interrupt.',
    setup: (cwd) => gitInit(cwd),
    processes: [
      {
        policy: 'approval-required',
        turns: [
          {
            say: 'Run the shell command `touch z.txt`, then reply with only DONE.',
            answer: () => null,
            interruptWhen: isMethod('item/commandExecution/requestApproval')
          }
        ]
      }
    ]
  },
  'interrupt-command': {
    note: 'full-access: turn/interrupt while a command runs.',
    processes: [
      {
        policy: 'full-access',
        turns: [
          {
            say: 'Run the shell command `sleep 20`, then reply with only DONE.',
            interruptWhen: itemStartedOf('commandExecution')
          }
        ]
      }
    ]
  },
  'interrupt-text': {
    note: 'turn/interrupt mid-reply, then a second turn in the same thread.',
    processes: [
      {
        policy: 'auto-accept-edits',
        turns: [
          {
            say: 'Write a 300-word story about a lighthouse keeper.',
            interruptWhen: afterDeltas(5)
          },
          { say: 'Reply with exactly the word: OK' }
        ]
      }
    ]
  },
  'web-search': {
    note: 'web_search="live" (a -c flag): a webSearch item.',
    processes: [
      {
        policy: 'auto-accept-edits',
        extraArgs: () => ['-c', 'web_search="live"'],
        turns: [
          {
            say: 'Search the web for the official GitHub repository of the OpenAI Codex CLI and reply with its URL only.'
          }
        ]
      }
    ]
  },
  'mcp-tool': {
    note: 'A local MCP stdio server (slz_echo) given by -c flags: an mcpToolCall item.',
    setup: (cwd) => fs.writeFileSync(path.join(cwd, 'mcp-echo.mjs'), MCP_ECHO_SERVER),
    processes: [
      {
        policy: 'full-access',
        extraArgs: (cwd) => [
          '-c',
          `mcp_servers.slz_echo.command=${JSON.stringify(process.execPath)}`,
          '-c',
          `mcp_servers.slz_echo.args=[${JSON.stringify(path.join(cwd, 'mcp-echo.mjs'))}]`
        ],
        turns: [
          {
            say: "Call the echo tool of the slz_echo MCP server with text 'ping' and reply with exactly what it returned.",
            answer: (method) =>
              method === 'mcpServer/elicitation/request'
                ? { action: 'accept', content: null }
                : accept()
          }
        ]
      }
    ]
  },
  'plan-update': {
    note: 'The update_plan tool: turn/plan/updated.',
    processes: [
      {
        policy: 'auto-accept-edits',
        turns: [
          {
            say: 'Use your update_plan tool to make a plan of exactly 2 steps (step one, step two), then mark both completed, then reply with only DONE.'
          }
        ]
      }
    ]
  },
  resume: {
    note: 'A thread started, then thread/resume in a second process continues it.',
    processes: [
      {
        policy: 'auto-accept-edits',
        turns: [{ say: 'Remember the code word: banana. Reply with only OK.' }]
      },
      {
        policy: 'auto-accept-edits',
        resume: 'previous',
        turns: [{ say: 'What was the code word? Reply with only the word.' }]
      }
    ]
  },
  'resume-missing': {
    note: 'thread/resume of a thread id that does not exist.',
    processes: [{ policy: 'auto-accept-edits', resume: 'missing', turns: [] }]
  },
  'model-refused': {
    note: "chat's default Codex model (gpt-5.5, chat-model-catalog.ts) on a ChatGPT login: an error notification, the turn fails.",
    processes: [
      {
        policy: 'auto-accept-edits',
        turns: [{ say: 'Reply with exactly the word: OK', model: 'gpt-5.5' }]
      }
    ]
  },
  'bad-model': {
    note: 'turn/start with a model that does not exist.',
    processes: [
      {
        policy: 'auto-accept-edits',
        turns: [{ say: 'Reply with exactly the word: OK', model: 'gpt-slz-no-such-model' }]
      }
    ]
  },
  'sigterm-mid-turn': {
    note: 'SIGTERM while a command runs: what the CLI still prints before it exits.',
    processes: [
      {
        policy: 'full-access',
        turns: [
          {
            say: 'Run the shell command `sleep 20`, then reply with only DONE.',
            sigtermWhen: itemStartedOf('commandExecution')
          }
        ]
      }
    ]
  },
  'stdin-close-mid-turn': {
    note: 'stdin closed while a command runs.',
    processes: [
      {
        policy: 'full-access',
        turns: [
          {
            say: 'Run the shell command `sleep 5`, then reply with only DONE.',
            closeStdinWhen: itemStartedOf('commandExecution')
          }
        ]
      }
    ]
  }
}

async function gitInit(cwd: string): Promise<void> {
  await promisify(execFile)('git', ['init', '-q'], { cwd })
}

// --- redaction ----------------------------------------------------------------

interface RedactCtx {
  threadIds: Set<string>
  turnIds: Set<string>
  cwds: string[]
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** macOS per-user temp root (`/var/folders/xx/yyyy/T/`). */
const MAC_TMP = /\/(?:private\/)?var\/folders\/[^/\s"]+\/[^/\s"]+\/T\//g
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g
/** Account figures: kept in shape, never in value. */
const SCRUB_NUMBERS = new Set(['usedPercent', 'resetsAt', 'balance', 'windowDurationMins'])

function redactString(s: string, ctx: RedactCtx): string {
  let out = s
  for (const id of ctx.threadIds) out = out.split(id).join('{{threadId}}')
  for (const id of ctx.turnIds) out = out.split(id).join('{{turnId}}')
  for (const cwd of ctx.cwds) out = out.split(cwd).join('{{cwd}}')
  out = out.replace(MAC_TMP, '/tmp/')
  const home = os.homedir()
  out = out.split(home).join('/Users/user')
  const user = os.userInfo().username
  if (user.length > 2) out = out.replace(new RegExp(`\\b${user}\\b`, 'gi'), 'user')
  const host = os.hostname()
  if (host.length > 2) out = out.split(host).join('host.local')
  out = out.replace(JWT, '<jwt>')
  return out.replace(EMAIL, (m) => (m.endsWith('@example.com') ? m : 'user@example.com'))
}

/** Field-level scrubbing for server lines, before the string pass. */
function redactMessage(msg: Json): Json {
  const method = typeof msg.method === 'string' ? msg.method : ''
  if (method.startsWith('account/')) return { ...msg, params: scrubAccount(msg.params) }
  if (method === 'mcpServer/startupStatus/updated') {
    const params = { ...(msg.params as Json) }
    if (typeof params.name === 'string' && !KNOWN_MCP_SERVERS.has(params.name))
      params.name = 'user_server'
    return { ...msg, params }
  }
  if (method === 'remoteControl/status/changed') {
    const params = { ...(msg.params as Json) }
    if (typeof params.installationId === 'string')
      params.installationId = '00000000-0000-4000-8000-000000000000'
    return { ...msg, params }
  }
  return msg
}
function scrubAccount(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubAccount)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Json).map(([k, v]) => {
      if (SCRUB_NUMBERS.has(k) && typeof v === 'number') return [k, 0]
      if (k === 'planType' && typeof v === 'string') return [k, 'plus']
      if ((k === 'limitId' || k === 'limitName') && typeof v === 'string') return [k, v]
      return [k, scrubAccount(v)]
    })
  )
}

// --- driver -------------------------------------------------------------------

interface Recorder {
  records: TranscriptRecord[]
  redact: RedactCtx
}

class Proc {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly t0 = Date.now()
  private nextId = 1
  private readonly pending = new Map<number, (msg: Json) => void>()
  private readonly listeners = new Set<(msg: Json) => void>()
  private buf = ''
  answer: TurnSpec['answer'] = accept
  readonly exited: Promise<void>

  constructor(
    private readonly rec: Recorder,
    index: number,
    args: string[],
    cwd: string
  ) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('SLAYZONE_'))
    )
    this.child = spawn(CODEX_BIN, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    rec.records.push({ kind: 'process', index, argv: args.map((a) => redactString(a, rec.redact)) })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      this.buf += chunk
      let nl = this.buf.indexOf('\n')
      while (nl >= 0) {
        const line = this.buf.slice(0, nl)
        this.buf = this.buf.slice(nl + 1)
        if (line.trim()) this.onLine(line)
        nl = this.buf.indexOf('\n')
      }
    })
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.rec.records.push({
        kind: 'stderr',
        t: this.t(),
        text: redactString(chunk.toString('utf8'), this.rec.redact)
      })
    })
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        this.rec.records.push({ kind: 'exit', t: this.t(), code, signal })
        resolve()
      })
    })
  }

  private t(): number {
    return Date.now() - this.t0
  }

  private onLine(line: string): void {
    let msg: Json
    try {
      msg = JSON.parse(line) as Json
    } catch {
      this.rec.records.push({
        kind: 'stdout',
        t: this.t(),
        line: redactString(line, this.rec.redact)
      })
      return
    }
    // Learn ids before redacting the line that carries them.
    const result = msg.result as Json | undefined
    const threadId = (result?.thread as Json | undefined)?.id
    if (typeof threadId === 'string') this.rec.redact.threadIds.add(threadId)
    const turnId =
      (result?.turn as Json | undefined)?.id ?? (msg.params as Json | undefined)?.turnId
    if (typeof turnId === 'string') this.rec.redact.turnIds.add(turnId)
    const startedTurn = ((msg.params as Json | undefined)?.turn as Json | undefined)?.id
    if (typeof startedTurn === 'string') this.rec.redact.turnIds.add(startedTurn)
    this.rec.records.push({
      kind: 'stdout',
      t: this.t(),
      line: redactString(JSON.stringify(redactMessage(msg)), this.rec.redact)
    })
    const isResponse = msg.id !== undefined && msg.method === undefined
    if (isResponse) {
      const waiter = this.pending.get(msg.id as number)
      this.pending.delete(msg.id as number)
      waiter?.(msg)
    } else if (msg.id !== undefined && typeof msg.method === 'string') {
      const reply = this.answer?.(msg.method, (msg.params ?? {}) as Json)
      if (reply === undefined)
        this.send({ id: msg.id, error: { code: -32601, message: 'unhandled' } })
      else if (reply !== null) this.send({ id: msg.id, result: reply })
    }
    for (const l of [...this.listeners]) l(msg)
  }

  send(msg: Json): void {
    const line = JSON.stringify({ jsonrpc: '2.0', ...msg })
    this.rec.records.push({ kind: 'stdin', t: this.t(), line: redactString(line, this.rec.redact) })
    this.child.stdin.write(`${line}\n`)
  }

  request(method: string, params: unknown, timeoutMs = 60_000): Promise<Json> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      this.send({ id, method, params })
    })
  }

  /** Resolve with the first server line matching `pred` from now on. */
  waitFor(pred: (msg: Json) => boolean, timeoutMs: number, label: string): Promise<Json> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(l)
        reject(new Error(`timed out waiting for ${label}`))
      }, timeoutMs)
      const l = (msg: Json): void => {
        if (!pred(msg)) return
        clearTimeout(timer)
        this.listeners.delete(l)
        resolve(msg)
      }
      this.listeners.add(l)
    })
  }

  onEvery(l: (msg: Json) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  kill(signal: NodeJS.Signals): void {
    this.child.kill(signal)
  }

  closeStdin(): void {
    this.child.stdin.end()
  }

  async end(): Promise<void> {
    this.closeStdin()
    const timer = setTimeout(() => this.child.kill('SIGTERM'), 15_000)
    await this.exited
    clearTimeout(timer)
  }
}

async function runProcess(
  rec: Recorder,
  spec: ProcSpec,
  index: number,
  cwd: string,
  previousThread: string | null
): Promise<string | null> {
  const args = ['app-server', ...(spec.extraArgs?.(cwd) ?? [])]
  const proc = new Proc(rec, index, args, cwd)
  const policy = policyParams(spec.policy, cwd)
  const init = await proc.request('initialize', {
    clientInfo: CLIENT_INFO,
    capabilities: { experimentalApi: true, requestAttestation: false }
  })
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`)
  proc.send({ method: 'initialized' })

  let threadId: string | null = null
  if (spec.resume) {
    const id = spec.resume === 'previous' ? previousThread : randomUUID()
    if (!id) throw new Error('resume: no previous thread')
    rec.redact.threadIds.add(id)
    const res = await proc.request('thread/resume', {
      threadId: id,
      cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox
    })
    threadId = res.error ? null : id
  } else {
    const res = await proc.request('thread/start', {
      cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      model: MODEL
    })
    threadId = ((res.result as Json | undefined)?.thread as Json | undefined)?.id as string
  }

  let ended = false
  for (const turn of spec.turns) {
    if (!threadId || ended) break
    proc.answer = turn.answer ?? accept
    const done = proc.waitFor(
      (m) => m.method === 'turn/completed',
      TURN_TIMEOUT_MS,
      `turn/completed of '${turn.say}'`
    )
    let turnId: string | null = null
    let fired = false
    const off = proc.onEvery((msg) => {
      if (fired) return
      if (turn.interruptWhen?.(msg) && threadId) {
        fired = true
        const sendInterrupt = (): void =>
          void proc
            .request('turn/interrupt', { threadId, turnId })
            .catch((err: unknown) => console.warn(`  turn/interrupt: ${String(err)}`))
        if (turnId) sendInterrupt()
        else setTimeout(sendInterrupt, 200)
      } else if (turn.sigtermWhen?.(msg)) {
        fired = true
        ended = true
        proc.kill('SIGTERM')
      } else if (turn.closeStdinWhen?.(msg)) {
        fired = true
        ended = true
        proc.closeStdin()
      }
    })
    const res = await proc.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: turn.say, text_elements: [] }],
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: policy.sandboxPolicy,
      model: turn.model ?? MODEL,
      effort: turn.effort ?? EFFORT
    })
    turnId = ((res.result as Json | undefined)?.turn as Json | undefined)?.id as string | null
    if (res.error) {
      off()
      continue
    }
    await Promise.race([done, proc.exited]).catch((err: unknown) => {
      console.warn(`  ${String(err)}`)
    })
    off()
  }
  if (!ended) await proc.end()
  else {
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000)
    await proc.exited
    clearTimeout(timer)
  }
  return threadId
}

async function record(name: string, recipe: Recipe, cliVersion: string): Promise<void> {
  const cwd = WORK_DIR
  fs.rmSync(cwd, { recursive: true, force: true })
  fs.mkdirSync(cwd, { recursive: true })
  await recipe.setup?.(cwd)
  const rec: Recorder = {
    records: [
      {
        kind: 'header',
        recipe: name,
        cliVersion,
        model: MODEL,
        recordedAt: new Date().toISOString().slice(0, 10),
        note: recipe.note
      }
    ],
    // Both spellings: the CLI reports the realpath (/private/var/… on macOS).
    redact: { threadIds: new Set(), turnIds: new Set(), cwds: [fs.realpathSync(cwd), cwd] }
  }
  let previous: string | null = null
  for (const [i, spec] of recipe.processes.entries()) {
    previous = await runProcess(rec, spec, i, cwd, previous)
  }
  // Ids learnt late (a turn id first seen after lines that carry it) — one more pass.
  rec.records = rec.records.map((r) =>
    r.kind === 'stdout' || r.kind === 'stdin'
      ? { ...r, line: redactString(r.line, rec.redact) }
      : r.kind === 'stderr'
        ? { ...r, text: redactString(r.text, rec.redact) }
        : r
  )
  fs.mkdirSync(CODEX_TRANSCRIPTS_DIR, { recursive: true })
  const file = path.join(CODEX_TRANSCRIPTS_DIR, `${name}.jsonl`)
  fs.writeFileSync(file, `${rec.records.map((r) => JSON.stringify(r)).join('\n')}\n`)
  const stdout = rec.records.filter((r) => r.kind === 'stdout').length
  console.log(`recorded ${name}: ${rec.records.length} records (${stdout} stdout) → ${file}`)
}

async function main(): Promise<void> {
  const { stdout } = await promisify(execFile)(CODEX_BIN, ['--version'], { encoding: 'utf8' })
  const cliVersion = stdout.trim().split(' ').at(-1) ?? 'unknown'
  const wanted = process.argv.slice(2)
  const names = wanted.length > 0 ? wanted : Object.keys(RECIPES)
  for (const name of names) {
    const recipe = RECIPES[name]
    if (!recipe)
      throw new Error(`unknown recipe '${name}' (have: ${Object.keys(RECIPES).join(', ')})`)
    await record(name, recipe, cliVersion)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
