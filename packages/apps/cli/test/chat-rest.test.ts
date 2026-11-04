/**
 * `slay chat` / `slay agent` → REST: the bundled CLI (dist/slay.js) as a subprocess
 * against the real `/api/chat/*` + `/api/agent/*` routes, over a scripted chat runtime
 * (`chat-access-testkit`). Proves the wire shapes, exit codes and the self-wait guard.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/cli/test/chat-rest.test.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import express from 'express'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../shared/test-utils/rest-harness.js'
import { registerChatRoutes } from '../../../apps/api/src/http/rest-api/chat/index.js'
import { registerAgentRoutes } from '../../../apps/api/src/http/rest-api/agent/index.js'
import { createFakeChat } from '../../../apps/api/src/http/rest-api/chat/chat-access-testkit.js'

const SLAY_BIN = path.resolve(import.meta.dirname, '../dist/slay.js')
const HAS_SLAY_BIN = fs.existsSync(SLAY_BIN)
if (!HAS_SLAY_BIN) {
  console.error('SKIP: dist/slay.js not built. Run `pnpm --filter @slayzone/cli build` first.')
}

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')
const task = crypto.randomUUID()
h.db
  .prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
  .run(task, projectId, 'Chat')

const fake = createFakeChat()
const app = express()
app.use(express.json())
registerChatRoutes(app, { db: h.slayDb, notifyRenderer: () => {}, chat: fake.chat })
registerAgentRoutes(app, { db: h.slayDb, notifyRenderer: () => {}, chat: fake.chat })
const rest = await mountRestApp(app)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-cli-chat-'))

afterAll(async () => {
  await rest.close()
  h.cleanup()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
beforeEach(() => fake.reset())

function runCli(
  args: string[],
  env: Record<string, string | undefined> = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const full: Record<string, string> = {
      ...(process.env as Record<string, string>),
      SLAYZONE_ROOT: tmpDir,
      SLAYZONE_DEV: '1',
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${rest.port}`
    }
    delete full.SLAYZONE_TASK_ID
    delete full.SLAYZONE_AGENT_ID
    delete full.SLAYZONE_AGENT_HOOK_CONTEXT
    delete full.SLAYZONE_CLI_RELAY_ADDRESS
    delete full.SLAYZONE_CLI_RELAY_TOKEN
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete full[k]
      else full[k] = v
    }
    const p = spawn('node', [SLAY_BIN, ...args], { env: full, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d.toString()))
    p.stderr.on('data', (d) => (stderr += d.toString()))
    p.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

const prompt = (requestId: string): AgentEvent =>
  ({
    kind: 'permission-request',
    requestId,
    toolName: 'AskUserQuestion',
    toolUseId: 'tu',
    input: {
      questions: [
        {
          question: 'Which db?',
          header: 'DB',
          options: [{ label: 'SQLite' }, { label: 'Postgres' }]
        }
      ]
    }
  }) as AgentEvent

describe.skipIf(!HAS_SLAY_BIN)('slay chat', () => {
  test('send prints the message id and queues it', async () => {
    const r = await runCli(['chat', 'send', 'hello', '--task', task.slice(0, 8)])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout.trim()).toMatch(/^[0-9a-f-]{36}$/)
    expect(fake.calls.find((c) => c[0] === 'push')?.slice(1, 3)).toEqual([task, 'hello'])
  })

  test('wait: 0 idle, 3 parked on a prompt, 2 timeout', async () => {
    expect((await runCli(['chat', 'wait', '--task', task])).code).toBe(0)
    fake.status = { state: 'idle', turnOpen: true, pendingRequestIds: ['r1'], outboxInFlight: 0 }
    const parked = await runCli(['chat', 'wait', '--task', task])
    expect(parked.code).toBe(3)
    expect(parked.stdout).toMatch(/slay chat prompts/)
    fake.status = { state: 'running', turnOpen: true, pendingRequestIds: [], outboxInFlight: 0 }
    expect((await runCli(['chat', 'wait', '--task', task, '--timeout', '1000'])).code).toBe(2)
  })

  test('prompts lists the question; answer maps positional answers to questions', async () => {
    fake.buffer = [{ seq: 1, event: prompt('req-abc') }]
    fake.status = {
      state: 'idle',
      turnOpen: true,
      pendingRequestIds: ['req-abc'],
      outboxInFlight: 0
    }
    const list = await runCli(['chat', 'prompts', '--task', task])
    expect(list.stdout).toContain('req-abc  [question]')
    expect(list.stdout).toContain('1. [DB] Which db?')
    const r = await runCli(['chat', 'answer', 'req', '2', '--task', task])
    expect(r.code, r.stderr).toBe(0)
    const call = fake.calls.find((c) => c[0] === 'respondPermission')
    expect(call?.[2]).toMatchObject({
      requestId: 'req-abc',
      optionId: 'answer',
      decision: { behavior: 'allow', updatedInput: { answers: { 'Which db?': 'Postgres' } } }
    })
  })

  test('a bad answer exits 1 with the server’s reason', async () => {
    fake.buffer = [{ seq: 1, event: prompt('req-abc') }]
    fake.status = {
      state: 'idle',
      turnOpen: true,
      pendingRequestIds: ['req-abc'],
      outboxInFlight: 0
    }
    const r = await runCli(['chat', 'respond', 'req-abc', 'nope', '--task', task])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/Unknown option "nope"/)
  })

  test('a chat agent waiting on its own turn is refused', async () => {
    const r = await runCli(['chat', 'wait'], {
      SLAYZONE_TASK_ID: task,
      SLAYZONE_AGENT_HOOK_CONTEXT: JSON.stringify({ v: 1, agentId: 'claude', mode: 'claude-chat' })
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/your own chat turn/)
    // The same task from a terminal shell is fine.
    expect((await runCli(['chat', 'wait'], { SLAYZONE_TASK_ID: task })).code).toBe(0)
  })
})

describe.skipIf(!HAS_SLAY_BIN)('slay agent', () => {
  test('start wakes a cold chat without a message; no-op once running', async () => {
    fake.status = null
    const cold = await runCli(['agent', 'start', '--task', task])
    expect(cold.code, cold.stderr).toBe(0)
    expect(cold.stdout.trim()).toBe('started')
    expect(fake.calls).toEqual([['startMain', task]])
    fake.reset()
    const warm = await runCli(['agent', 'start', '--task', task])
    expect(warm.code, warm.stderr).toBe(0)
    expect(warm.stdout.trim()).toBe('already running')
    expect(fake.calls).toEqual([])
  })

  test('send --wait on a chat task waits for the turn', async () => {
    const r = await runCli(['agent', 'send', 'go', '--wait', '--task', task])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('idle')
  })
})
