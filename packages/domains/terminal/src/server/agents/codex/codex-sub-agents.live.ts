/**
 * Live check for Codex sub-agents — the REAL driver against a REAL `codex
 * app-server`: the parent spawns a sub-agent that runs a long command; a Stop
 * while it runs must stop the sub-agent too (its row ends `interrupted`), and
 * the child's events must nest under its row.
 *
 * Opt-in (hits the OpenAI backend with the cheapest model, a few cents) — NOT
 * part of run-all.sh:
 *   npx tsx packages/domains/terminal/src/server/agents/codex/codex-sub-agents.live.ts
 *
 * Env: `SLAYZONE_CODEX_BIN_PATH` (default `codex` on PATH), `SLAYZONE_CODEX_RECORD_DIR`
 * (the work dir, default `<tmpdir>/slz-codex-rec`; see the recorder).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { initialState, reducer } from '../../../shared/chat-timeline'
import type { ChatDriverContext } from '../types'
import { codexChatBackend } from './codex-chat-session'

const CODEX_BIN = process.env.SLAYZONE_CODEX_BIN_PATH || 'codex'
const WORK_DIR = process.env.SLAYZONE_CODEX_RECORD_DIR || path.join(os.tmpdir(), 'slz-codex-rec')
const TIMEOUT_MS = 180_000

function waitFor(pred: () => boolean, label: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = setInterval(() => {
      if (pred()) {
        clearInterval(poll)
        resolve()
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll)
        reject(new Error(`timed out waiting for ${label}`))
      }
    }, 100)
  })
}

async function main(): Promise<void> {
  fs.mkdirSync(WORK_DIR, { recursive: true })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('SLAYZONE_'))
  )
  const child = spawn(CODEX_BIN, ['app-server'], {
    cwd: WORK_DIR,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const emitted: AgentEvent[] = []
  const driver = codexChatBackend.createDriver()
  const ctx: ChatDriverContext = {
    write: (line) => child.stdin.write(`${line}\n`),
    emit: (event) => {
      emitted.push(event)
      if (event.kind === 'sub-agent')
        console.log(`  sub-agent ${event.toolUseId}: ${event.phase} ${event.status ?? ''}`)
      else if (event.kind === 'result') console.log(`  result: ${event.subtype}`)
      else if (event.kind === 'tool-call')
        console.log(`  tool-call ${event.name}${event.parentToolUseId ? ' (nested)' : ''}`)
      else if (event.kind === 'assistant-text' || event.kind === 'error')
        console.log(`  ${event.kind}: ${'text' in event ? event.text : event.message}`)
    },
    cwd: WORK_DIR,
    sessionId: '',
    resume: false,
    providerFlags: [],
    chatModel: 'gpt-6-luna',
    chatEffort: 'low',
    chatMode: 'full-access',
    chatCollaboration: null,
    chatFastMode: false
  }
  createInterface({ input: child.stdout }).on('line', (line) => driver.handleLine(line))
  child.stderr.resume()

  await driver.start(ctx)
  driver.sendUserMessage(
    'Use your spawn_agent tool to start exactly one sub-agent with the task: "Run the shell command: sleep 60. Then reply with exactly the word DONE." Then use your wait tool until it finishes. Then reply with only the word it answered.'
  )
  const nestedCommand = (): boolean =>
    emitted.some(
      (e) =>
        e.kind === 'tool-call' && e.name === 'codex/commandExecution' && e.parentToolUseId != null
    )
  await waitFor(nestedCommand, "the sub-agent's command (nested)", TIMEOUT_MS)
  console.log('✓ the sub-agent runs its command, nested under its row — Stop')
  void driver.applyControl?.({ subtype: 'interrupt' }, 10_000)
  const subAgentEnded = (): boolean =>
    emitted.some((e) => e.kind === 'sub-agent' && e.phase === 'failed')
  await waitFor(subAgentEnded, 'the sub-agent to end after Stop', 30_000)
  const state = reducer(initialState(), { type: 'events', events: emitted })
  const rows = state.timeline.filter((r) => r?.kind === 'sub-agent')
  console.log(`✓ the sub-agent stopped with the turn: ${JSON.stringify(rows)}`)
  driver.dispose()
  child.kill('SIGTERM')
  process.exit(0)
}

main().catch((err: unknown) => {
  console.error('\n✗', err)
  process.exit(1)
})
