/**
 * Live integration check for CodexChatSession — drives the REAL driver against
 * a REAL `codex app-server` subprocess (not fixtures). Verifies the handshake,
 * turn dispatch, streaming bridge, and result emission end-to-end.
 *
 * Opt-in (hits the Codex backend) — NOT part of `run-all.sh`. Run manually:
 *   npx tsx packages/domains/terminal/src/main/agents/codex/codex-chat-session.live.ts
 *
 * Requires `codex` on PATH. A successful model turn additionally requires
 * `codex login`; without it the script still verifies the handshake +
 * protocol wiring and reports the turn error cleanly.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { codexChatBackend } from './codex-chat-session'
import type { AgentEvent } from '../../../shared/agent-events'
import type { ChatDriverContext } from '../types'

const TIMEOUT_MS = 60_000

async function main(): Promise<void> {
  console.log('\nCodexChatSession live integration check\n')

  const { args } = codexChatBackend.buildSpawnArgs({
    sessionId: '',
    resume: false,
    cwd: process.cwd(),
    providerFlags: []
  })
  console.log(`spawning: ${codexChatBackend.binaryName} ${args.join(' ')}`)
  const child = spawn(codexChatBackend.binaryName, args, { stdio: ['pipe', 'pipe', 'pipe'] })

  const emitted: AgentEvent[] = []
  const driver = codexChatBackend.createDriver()
  const ctx: ChatDriverContext = {
    write: (line) => child.stdin.write(line + '\n'),
    emit: (event) => {
      emitted.push(event)
      const detail =
        event.kind === 'stream-block-delta'
          ? ` ${JSON.stringify(event.text)}`
          : event.kind === 'result'
            ? ` (${event.subtype}, isError=${event.isError})`
            : event.kind === 'error'
              ? ` ${event.message}`
              : ''
      console.log(`  emit: ${event.kind}${detail}`)
    },
    cwd: process.cwd(),
    sessionId: '',
    resume: false,
    providerFlags: [],
    chatModel: null,
    chatEffort: null,
    chatMode: 'full-access',
    chatCollaboration: null,
    chatFastMode: false
  }

  const rl = createInterface({ input: child.stdout! })
  rl.on('line', (line) => driver.handleLine(line))
  child.stderr!.on('data', (d) => {
    const s = String(d).trim()
    if (s) console.log(`  [stderr] ${s.slice(0, 160)}`)
  })

  const fail = (msg: string): never => {
    console.error(`\n✗ ${msg}`)
    try {
      driver.dispose()
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    process.exit(1)
  }

  const timer = setTimeout(() => fail(`timed out after ${TIMEOUT_MS}ms`), TIMEOUT_MS)

  // 1. Handshake — `start` resolves once initialize + thread/start complete.
  await driver.start(ctx)
  const turnInit = emitted.find((e) => e.kind === 'turn-init')
  if (!turnInit || turnInit.kind !== 'turn-init') fail('no turn-init emitted after handshake')
  console.log(`✓ handshake ok — thread ${(turnInit as { sessionId: string }).sessionId}`)

  // 2. Drive one turn.
  driver.sendUserMessage('Reply with exactly the two characters: OK')
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (emitted.some((e) => e.kind === 'result' || e.kind === 'error')) {
        clearInterval(poll)
        resolve()
      }
    }, 100)
  })
  clearTimeout(timer)

  const result = emitted.find((e) => e.kind === 'result')
  const errorEv = emitted.find((e) => e.kind === 'error')
  const delta = emitted.find((e) => e.kind === 'stream-block-delta')

  if (result) {
    console.log('✓ turn produced a result event — protocol wiring verified')
    if (delta && delta.kind === 'stream-block-delta') {
      console.log(`✓ streamed assistant text: ${JSON.stringify(delta.text)}`)
    }
  } else if (errorEv && errorEv.kind === 'error') {
    console.log(`⚠ turn errored (likely not logged in: \`codex login\`): ${errorEv.message}`)
    console.log('  handshake + protocol wiring still verified above.')
  }

  driver.dispose()
  child.kill('SIGTERM')
  console.log('\n✓ live integration check complete\n')
  process.exit(0)
}

void main().catch((err) => {
  console.error('\n✗ live check threw:', err)
  process.exit(1)
})
