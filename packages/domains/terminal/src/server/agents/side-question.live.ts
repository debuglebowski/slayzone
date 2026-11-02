/**
 * Live check for side questions (`/btw`) — drives the REAL drivers against the
 * REAL CLIs (Claude Code stream-json, `codex app-server`): a side question asked
 * mid-turn is answered, the main turn keeps running and finishes, nothing of the
 * side question reaches the main timeline; an idle follow-up carries history; a
 * cancel rejects.
 *
 * Opt-in (hits the providers' backends) — NOT part of `run-all.sh`. Run manually:
 *   npx tsx packages/domains/terminal/src/server/agents/side-question.live.ts [claude|codex]
 *
 * Requires `claude` / `codex` on PATH, logged in.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { claudeChatBackend } from './claude-session-driver'
import { codexChatBackend } from './codex/codex-chat-session'
import type { AgentBackend, ChatDriverContext } from './types'

const TURN_TIMEOUT_MS = 120_000
const SIDE_TIMEOUT_MS = 120_000

function check(ok: boolean, label: string): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}`)
  if (!ok) process.exitCode = 1
}

async function run(name: 'claude' | 'codex'): Promise<void> {
  const backend: AgentBackend = name === 'claude' ? claudeChatBackend : codexChatBackend
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `btw-live-${name}-`))
  const sessionId = name === 'claude' ? randomUUID() : ''
  const providerFlags = name === 'claude' ? ['--model', 'haiku'] : []
  const { args } = backend.buildSpawnArgs({ sessionId, resume: false, cwd, providerFlags })
  const child = spawn(backend.binaryName, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const events: AgentEvent[] = []
  const waiters = new Set<() => void>()
  const driver = backend.createDriver()
  const ctx: ChatDriverContext = {
    write: (line) => child.stdin.write(`${line}\n`),
    emit: (event) => {
      events.push(event)
      for (const w of [...waiters]) w()
    },
    cwd,
    sessionId,
    resume: false,
    providerFlags,
    chatModel: null,
    chatEffort: null,
    chatMode: name === 'claude' ? 'auto-accept' : 'auto-accept-edits',
    chatCollaboration: null,
    chatFastMode: false
  }
  createInterface({ input: child.stdout }).on('line', (line) => driver.handleLine(line))
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => {
      void driver.start(ctx)
      resolve()
    })
  })
  const waitFor = (pred: () => boolean, label: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), TURN_TIMEOUT_MS)
      const tick = (): void => {
        if (!pred()) return
        clearTimeout(timer)
        waiters.delete(tick)
        resolve()
      }
      waiters.add(tick)
      tick()
    })
  const results = (): number => events.filter((e) => e.kind === 'result').length
  const mainText = (from: number): string =>
    events
      .slice(from)
      .map((e) => (e.kind === 'stream-block-delta' ? e.text : ''))
      .join('')

  console.log(`\n${name}: side questions live check (${cwd})`)
  try {
    await spawned
    if (name === 'codex')
      await waitFor(() => events.some((e) => e.kind === 'turn-init'), 'handshake')
    driver.sendUserMessage('Say hi in exactly three words.')
    await waitFor(() => results() === 1, 'first turn')
    driver.sendUserMessage(
      'List the numbers 1 to 25, one per line, each with a one-sentence fun fact. Do not use tools.'
    )
    await waitFor(
      () => events.filter((e) => e.kind === 'stream-block-delta').length > 3 && results() === 1,
      'second turn streaming'
    )
    const before = events.length
    const t0 = Date.now()
    const mid = await driver.askSideQuestion!(
      {
        requestId: randomUUID(),
        question: 'What was the first thing I asked you? One sentence.',
        history: []
      },
      SIDE_TIMEOUT_MS
    )
    console.log(`  mid-turn answer (${Date.now() - t0}ms): ${JSON.stringify(mid.text)}`)
    check(
      !!mid.text && /hi|three|words|greet/i.test(mid.text),
      'mid-turn answer is about the first message'
    )
    check(results() === 1, 'main turn still running while answered')
    await waitFor(() => results() === 2, 'second turn end')
    check(
      events.filter((e) => e.kind === 'result').at(-1)?.kind === 'result',
      'main turn finished after the side question'
    )
    check(
      !mainText(before).includes(mid.text ?? '\u0000'),
      'side answer never in the main timeline'
    )

    const follow = await driver.askSideQuestion!(
      {
        requestId: randomUUID(),
        question: 'Repeat your previous side answer, word for word.',
        history: [{ question: 'What was the first thing I asked you?', answer: mid.text ?? '' }]
      },
      SIDE_TIMEOUT_MS
    )
    console.log(`  idle follow-up answer: ${JSON.stringify(follow.text)}`)
    check(!!follow.text, 'idle follow-up answered')

    const cancelId = randomUUID()
    const cancelled = driver.askSideQuestion!(
      { requestId: cancelId, question: 'Write a 500-word essay about the number 7.', history: [] },
      SIDE_TIMEOUT_MS
    )
    setTimeout(() => driver.cancelSideQuestion!(cancelId), 1500)
    const outcome = await cancelled.then(
      (a) => `answered: ${a.text?.slice(0, 60)}`,
      (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`
    )
    console.log(`  cancel: ${outcome}`)
    check(outcome.startsWith('rejected'), 'cancel rejects the question')
    check(results() === 2, 'no main turn from any side question')
  } finally {
    driver.dispose()
    child.kill()
  }
}

const PROVIDERS = ['claude', 'codex'] as const
const which = PROVIDERS.find((p) => p === process.argv[2])
const targets = which ? [which] : PROVIDERS
for (const t of targets)
  await run(t).catch((err: unknown) => {
    console.log(`  ✗ ${t}: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
process.exit()
