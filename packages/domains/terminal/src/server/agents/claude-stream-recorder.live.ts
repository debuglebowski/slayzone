/**
 * Records REAL `claude` CLI runs as transcripts — the fixtures the fake CLI
 * replays (`@slayzone/test-utils/fake-claude`) and the format drift check parses
 * (claude-stream-drift.test.ts). Format: test-utils/fake-claude/transcript.ts.
 *
 * Opt-in (hits the Anthropic API with `--model haiku`, a few cents) — NOT part of
 * run-all.sh. Re-record after a CLI update, then run the drift check:
 *   npx tsx packages/domains/terminal/src/server/agents/claude-stream-recorder.live.ts [recipe…]
 *
 * Spawns with the adapter's OWN `buildSpawnArgs`, so a recording is exactly what
 * chat sends, plus isolation flags (`--strict-mcp-config --setting-sources
 * project`) that keep the user's MCP servers, hooks and plugins out of it. Every
 * record is redacted before it is written (paths, ids, emails, usage figures);
 * review the diff before keeping a re-recording anyway.
 */
import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import { TRANSCRIPTS_DIR, type TranscriptRecord } from '@slayzone/test-utils/fake-claude'
import { claudeCodeAdapter } from './claude-code-adapter'

const MODEL = 'haiku'
const TURN_TIMEOUT_MS = 120_000
const ISOLATION_FLAGS = ['--strict-mcp-config', '--setting-sources', 'project']

type Json = Record<string, unknown>
type Decision = { behavior: 'allow'; updatedInput: Json } | { behavior: 'deny'; message: string }

interface Turn {
  say: string
  /** Answer a `can_use_tool` request. Default: allow with the proposed input. */
  decide?: (toolName: string, input: Json) => Decision
  /** Control requests sent (and answered) before the user message. */
  before?: Json[]
  /** Send ONE interrupt when this first matches a stdout event. */
  interruptWhen?: (event: Json) => boolean
}

interface ProcSpec {
  /** `previous`: --resume the previous process's session. `missing`: a random id. */
  resume?: 'previous' | 'missing'
  permissionMode: 'acceptEdits' | 'default' | 'plan'
  turns: Turn[]
}

interface Recipe {
  note: string
  setup?: (cwd: string) => void
  processes: ProcSpec[]
}

/** Answer AskUserQuestion like the chat card does (renderers.tsx). */
function answerQuestion(label: string) {
  return (toolName: string, input: Json): Decision => {
    if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input }
    const questions = (input.questions as Array<{ question: string }> | undefined) ?? []
    const answers = Object.fromEntries(questions.map((q) => [q.question, label]))
    return { behavior: 'allow', updatedInput: { ...input, answers } }
  }
}

/** ExitPlanMode answered the way chat does today (claude-session-driver.ts). */
const denyPlanLikeTheDriver = (toolName: string, input: Json): Decision =>
  toolName === 'ExitPlanMode'
    ? { behavior: 'deny', message: 'Plan mode requires explicit approval' }
    : { behavior: 'allow', updatedInput: input }

const PLAN_PROMPT =
  'Plan how to create a file hello.txt containing the text hi. Keep the plan to two short steps, then call ExitPlanMode with it.'

const RECIPES: Record<string, Recipe> = {
  'tool-turn': {
    note: 'Read then Bash in acceptEdits mode, two turns in one process.',
    setup: (cwd) => fs.writeFileSync(path.join(cwd, 'notes.txt'), 'banana split recipe\n'),
    processes: [
      {
        permissionMode: 'acceptEdits',
        turns: [
          { say: 'Use the Read tool to read notes.txt, then reply with only its first word.' },
          {
            say: 'Now use the Bash tool to run: echo recorded-ok — then reply with only its output.'
          }
        ]
      }
    ]
  },
  'permission-bash': {
    note: 'Default mode: Bash asks via can_use_tool. Turn 1 allowed, turn 2 denied.',
    processes: [
      {
        permissionMode: 'default',
        turns: [
          { say: 'Use the Bash tool to run exactly: touch created-by-claude.txt' },
          {
            say: 'Use the Bash tool to run exactly: rm created-by-claude.txt',
            decide: (toolName, input) =>
              toolName === 'Bash'
                ? { behavior: 'deny', message: 'The user denied this command.' }
                : { behavior: 'allow', updatedInput: input }
          }
        ]
      }
    ]
  },
  'ask-user-question': {
    note: 'AskUserQuestion answered through can_use_tool updatedInput.answers, as the chat card does.',
    processes: [
      {
        permissionMode: 'acceptEdits',
        turns: [
          {
            say: 'Use the AskUserQuestion tool to ask me which color I prefer, with exactly two options: Red and Blue. After I answer, reply with only the color I picked.',
            decide: answerQuestion('Blue')
          }
        ]
      }
    ]
  },
  'exit-plan-deny': {
    note: 'Plan mode: ExitPlanMode denied the way the driver does today; then the UI flow: set_permission_mode acceptEdits + the approval marker message.',
    processes: [
      {
        permissionMode: 'plan',
        turns: [
          { say: PLAN_PROMPT, decide: denyPlanLikeTheDriver },
          {
            say: '__slay_plan_approved__',
            before: [{ subtype: 'set_permission_mode', mode: 'acceptEdits' }]
          }
        ]
      }
    ]
  },
  'exit-plan-allow': {
    note: 'Plan mode: ExitPlanMode allowed (the CLI leaves plan mode itself) — what plan item 2.3 will do.',
    processes: [{ permissionMode: 'plan', turns: [{ say: PLAN_PROMPT }] }]
  },
  compact: {
    note: 'Two short turns, then /compact as a chat message.',
    processes: [
      {
        permissionMode: 'acceptEdits',
        turns: [
          { say: 'Reply with only: one' },
          { say: 'Reply with only: two' },
          { say: '/compact' }
        ]
      }
    ]
  },
  resume: {
    note: 'Process 0 starts a session; process 1 resumes it with --resume.',
    processes: [
      {
        permissionMode: 'acceptEdits',
        turns: [{ say: 'Remember the word APPLE. Reply with only: OK' }]
      },
      {
        resume: 'previous',
        permissionMode: 'acceptEdits',
        turns: [{ say: 'What word did I ask you to remember? Reply with only the word.' }]
      }
    ]
  },
  'resume-missing': {
    note: '--resume of a conversation that does not exist (fails at startup).',
    processes: [
      {
        resume: 'missing',
        permissionMode: 'acceptEdits',
        turns: [{ say: 'Reply with only: hello' }]
      }
    ]
  },
  'interrupt-tool': {
    note: 'Interrupt while a Bash tool runs; then a normal turn in the same process.',
    processes: [
      {
        permissionMode: 'acceptEdits',
        turns: [
          {
            say: 'Use the Bash tool to run: sleep 20; echo done — then summarize the output.',
            interruptWhen: (e) =>
              e.type === 'assistant' &&
              JSON.stringify((e.message as Json | undefined)?.content ?? '').includes('"tool_use"')
          },
          { say: 'Reply with only: AFTER' }
        ]
      }
    ]
  },
  'interrupt-text': {
    note: 'Interrupt right after init, before any tool; then a normal turn.',
    processes: [
      {
        permissionMode: 'acceptEdits',
        turns: [
          {
            say: 'Write a 400-word story about a lighthouse keeper.',
            interruptWhen: (e) => e.type === 'system' && e.subtype === 'init'
          },
          { say: 'Reply with only: AFTER' }
        ]
      }
    ]
  },
  'control-requests': {
    note: 'set_model / set_permission_mode answered by the CLI, then a turn.',
    processes: [
      {
        permissionMode: 'acceptEdits',
        turns: [
          {
            say: 'Reply with only: A',
            before: [
              { subtype: 'set_model', model: MODEL },
              { subtype: 'set_permission_mode', mode: 'plan' },
              { subtype: 'set_permission_mode', mode: 'acceptEdits' }
            ]
          }
        ]
      }
    ]
  }
}

// --- redaction ----------------------------------------------------------------

interface RedactCtx {
  sessionIds: Set<string>
  cwds: string[]
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
/** macOS per-user temp root (`/var/folders/xx/yyyy/T/`) and its slug in ~/.claude paths. */
const MAC_TMP = /\/(?:private\/)?var\/folders\/[^/\s"]+\/[^/\s"]+\/T\//g
const MAC_TMP_SLUG = /-private-var-folders-[A-Za-z0-9_-]+?-T-slz-claude-rec-[A-Za-z0-9]+/g

function redactString(s: string, ctx: RedactCtx): string {
  let out = s
  for (const id of ctx.sessionIds) out = out.split(id).join('{{sessionId}}')
  for (const cwd of ctx.cwds) out = out.split(cwd).join('{{cwd}}')
  out = out.replace(MAC_TMP_SLUG, '-cwd-slug').replace(MAC_TMP, '/tmp/')
  const home = os.homedir()
  out = out.split(home).join('/Users/user')
  const user = os.userInfo().username
  if (user.length > 2) out = out.replace(new RegExp(`\\b${user}\\b`, 'gi'), 'user')
  return out.replace(EMAIL, (m) => (m.endsWith('@example.com') ? m : 'user@example.com'))
}

/** Field-level scrubbing for stdout events, before the string pass. */
function redactEvent(event: Json): Json {
  if (event.type === 'rate_limit_event') {
    const info = { ...(event.rate_limit_info as Json) }
    info.resetsAt = 1_800_000_000
    if (info.unifiedWindows && typeof info.unifiedWindows === 'object') {
      info.unifiedWindows = Object.fromEntries(
        Object.entries(info.unifiedWindows as Record<string, Json>).map(([k, w]) => [
          k,
          { ...w, utilization: 0, resetsAt: 1_800_000_000 }
        ])
      )
    }
    return { ...event, rate_limit_info: info }
  }
  if (event.type === 'system' && event.subtype === 'init') {
    const tools = Array.isArray(event.tools) ? (event.tools as string[]) : []
    return {
      ...event,
      // Account-specific connectors; never part of the stream contract.
      tools: tools.filter((t) => !t.startsWith('mcp__')),
      mcp_servers: []
    }
  }
  return event
}

// --- driver -------------------------------------------------------------------

interface Recorder {
  records: TranscriptRecord[]
  redact: RedactCtx
}

async function runProcess(
  rec: Recorder,
  spec: ProcSpec,
  procIndex: number,
  cwd: string,
  previousSessionId: string | null
): Promise<string> {
  const resume = spec.resume !== undefined
  const sessionId =
    spec.resume === 'previous' && previousSessionId ? previousSessionId : randomUUID()
  rec.redact.sessionIds.add(sessionId)
  const { args } = claudeCodeAdapter.buildSpawnArgs({
    sessionId,
    resume,
    cwd,
    providerFlags: ['--model', MODEL, '--permission-mode', spec.permissionMode, ...ISOLATION_FLAGS]
  })
  rec.records.push({
    kind: 'process',
    index: procIndex,
    argv: args.map((a) => redactString(a, rec.redact))
  })
  const t0 = Date.now()
  const t = (): number => Date.now() - t0
  const child: ChildProcessWithoutNullStreams = spawn('claude', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const listeners = new Set<(event: Json) => void>()
  let exited: { code: number | null; signal: string | null } | null = null
  const exitWaiters = new Set<() => void>()
  const decoder = new StringDecoder('utf8')
  let buf = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buf += decoder.write(chunk)
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
      if (!line.trim()) continue
      let event: Json
      try {
        event = JSON.parse(line) as Json
      } catch {
        rec.records.push({ kind: 'stdout', t: t(), line: redactString(line, rec.redact) })
        continue
      }
      rec.records.push({
        kind: 'stdout',
        t: t(),
        line: redactString(JSON.stringify(redactEvent(event)), rec.redact)
      })
      for (const l of [...listeners]) l(event)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    rec.records.push({
      kind: 'stderr',
      t: t(),
      text: redactString(chunk.toString('utf8'), rec.redact)
    })
  })
  child.on('exit', (code, signal) => {
    exited = { code, signal: signal ?? null }
    rec.records.push({ kind: 'exit', t: t(), code, signal: signal ?? null })
    for (const w of exitWaiters) w()
  })

  const write = (msg: Json): void => {
    const line = JSON.stringify(msg)
    rec.records.push({ kind: 'stdin', t: t(), line: redactString(line, rec.redact) })
    child.stdin.write(`${line}\n`)
  }
  /** Resolve on the first stdout event `pred` accepts, or on exit (null). */
  const waitFor = (pred: (event: Json) => boolean, label: string): Promise<Json | null> =>
    new Promise((resolve, reject) => {
      if (exited) return resolve(null)
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${label}`)),
        TURN_TIMEOUT_MS
      )
      const done = (v: Json | null): void => {
        clearTimeout(timer)
        listeners.delete(onEvent)
        exitWaiters.delete(onExit)
        resolve(v)
      }
      const onEvent = (event: Json): void => {
        if (pred(event)) done(event)
      }
      const onExit = (): void => done(null)
      listeners.add(onEvent)
      exitWaiters.add(onExit)
    })

  let controlSeq = 0
  for (const turn of spec.turns) {
    for (const request of turn.before ?? []) {
      controlSeq += 1
      const requestId = `rec_${controlSeq}`
      const reply = waitFor(
        (e) =>
          e.type === 'control_response' &&
          (e.response as Json | undefined)?.request_id === requestId,
        `control_response ${requestId}`
      )
      write({ type: 'control_request', request_id: requestId, request })
      await reply
    }
    let interrupted = false
    const onEvent = (event: Json): void => {
      if (event.type === 'control_request') {
        const req = event.request as Json
        if (req.subtype !== 'can_use_tool') return
        const toolName = req.tool_name as string
        const input = (req.input as Json | undefined) ?? {}
        const decision = turn.decide?.(toolName, input) ?? {
          behavior: 'allow',
          updatedInput: input
        }
        write({
          type: 'control_response',
          response: { subtype: 'success', request_id: event.request_id, response: decision }
        })
      }
      if (turn.interruptWhen && !interrupted && turn.interruptWhen(event)) {
        interrupted = true
        controlSeq += 1
        write({
          type: 'control_request',
          request_id: `rec_${controlSeq}`,
          request: { subtype: 'interrupt' }
        })
      }
    }
    listeners.add(onEvent)
    const result = waitFor((e) => e.type === 'result', 'result')
    write(JSON.parse(claudeCodeAdapter.serializeUserMessage(turn.say, sessionId)) as Json)
    await result
    listeners.delete(onEvent)
    if (exited) break
  }
  if (!exited) {
    child.stdin.end()
    await new Promise<void>((resolve) => {
      if (exited) return resolve()
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 30_000)
      exitWaiters.add(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  return sessionId
}

async function record(name: string, recipe: Recipe, cliVersion: string): Promise<void> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-claude-rec-'))
  recipe.setup?.(cwd)
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
    redact: { sessionIds: new Set(), cwds: [fs.realpathSync(cwd), cwd] }
  }
  let previous: string | null = null
  for (const [i, spec] of recipe.processes.entries()) {
    previous = await runProcess(rec, spec, i, cwd, previous)
  }
  fs.rmSync(cwd, { recursive: true, force: true })
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const file = path.join(TRANSCRIPTS_DIR, `${name}.jsonl`)
  fs.writeFileSync(file, `${rec.records.map((r) => JSON.stringify(r)).join('\n')}\n`)
  const stdout = rec.records.filter((r) => r.kind === 'stdout').length
  console.log(`recorded ${name}: ${rec.records.length} records (${stdout} stdout) → ${file}`)
}

async function main(): Promise<void> {
  const { stdout } = await promisify(execFile)('claude', ['--version'], { encoding: 'utf8' })
  const cliVersion = stdout.trim().split(' ')[0] ?? 'unknown'
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
