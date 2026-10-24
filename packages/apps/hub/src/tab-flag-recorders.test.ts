/**
 * Tab-flag recorder wiring — the seam that decides whether a restart restores
 * your agents.
 *
 * The regression this pins: `terminal_tabs.agent_state` (formerly `was_spawned`) is
 * written by a recorder inside pty-manager/chat-transport-manager, and that recorder was
 * installed ONLY by the Electron host (`apps/app/src/main/index.ts`). When the
 * pty runtime moved to the side-car (slice 9) and spawning moved to the computer,
 * the host stopped owning any session — so every recorder call became a
 * no-op, no agent was ever recorded running, and `listAutoRestoreTasks` had nothing
 * to restore. Same orphaning that killed idle-close and the warm pool.
 *
 * So this asserts the REAL module-global state of `@slayzone/terminal/server`
 * (not injected spies): after `wireTabFlagRecorders(db)` the pty AND chat
 * managers both hold a recorder, and driving it round-trips through
 * `setTabAgentState` into the real `terminal_tabs` row — including the idle-close
 * `auto_stopped` state, which no process ever wrote before.
 *
 * Plus a narrow source check that the hub's `stop()` sets the shutdown gate
 * BEFORE tearing the computer gateway down — the gate is what keeps a quit-time
 * exit cascade from clearing the very flags the next boot needs.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/tab-flag-recorders.test.ts
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createTestHarness, test, expect } from '../../../shared/test-utils/ipc-harness.js'
import {
  getPtyAgentStateTabRecorder,
  getChatAgentStateTabRecorder,
  setPtyAgentStateTabRecorder,
  setChatAgentStateTabRecorder
} from '@slayzone/terminal/server'
import { ensureMainTab } from '@slayzone/task-terminals/server'
import { wireTabFlagRecorders } from './tab-flag-recorders.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
const taskId = crypto.randomUUID()
h.db
  .prepare(
    'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
  )
  .run(taskId, projectId, 'T1', 'inbox', 3, 0)

const agentStateOf = (id: string): string =>
  (
    h.db.prepare('SELECT agent_state FROM terminal_tabs WHERE id = ?').get(id) as
      | { agent_state: string }
      | undefined
  )?.agent_state ?? 'missing'

test('tab-flag recorders: unwired by default (the orphaned state)', () => {
  setPtyAgentStateTabRecorder(null)
  setChatAgentStateTabRecorder(null)
  expect(getPtyAgentStateTabRecorder()).toBe(null)
  expect(getChatAgentStateTabRecorder()).toBe(null)
})

test('tab-flag recorders: wireTabFlagRecorders installs on BOTH pty and chat', () => {
  wireTabFlagRecorders(h.slayDb)
  const pty = getPtyAgentStateTabRecorder()
  const chat = getChatAgentStateTabRecorder()
  expect(typeof pty).toBe('function')
  expect(typeof chat).toBe('function')
  // One recorder, two managers — a chat agent and a pty agent must flip the
  // same column or restore is half-broken depending on the task's mode.
  expect(pty).toBe(chat)
})

test('tab-flag recorders: installed recorder round-trips into terminal_tabs', async () => {
  await ensureMainTab(h.slayDb, taskId, 'claude-code')
  expect(agentStateOf(taskId)).toBe('stopped')
  const record = getPtyAgentStateTabRecorder()!
  for (const state of ['running', 'auto_stopped', 'running', 'stopped'] as const) {
    record(taskId, state)
    await new Promise((r) => setTimeout(r, 20))
    expect(agentStateOf(taskId)).toBe(state)
  }
})

// The unit above proves the wiring WORKS; this proves it is CALLED. That gap is
// the whole bug — a correct recorder nobody installs is exactly what shipped.
// Booting composeServer to assert it for real pulls better-auth migrations + an
// artifact watcher (the reason hub-trpc-context/rest-auth were extracted), so
// the call site is pinned at source level instead.
test('composition root: calls wireTabFlagRecorders', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, 'composition.ts'), 'utf8')
  expect(src.includes("from './tab-flag-recorders.js'")).toBe(true)
  expect(src.includes('wireTabFlagRecorders(db)')).toBe(true)
})

test('hub stop(): sets the terminal shutdown gate before tearing down computers', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, 'server.ts'), 'utf8')
  const stopBody = src.slice(src.indexOf('stop: async () => {'))
  const gateAt = stopBody.indexOf('beginTerminalShutdown()')
  const computerTeardownAt = stopBody.indexOf('computerGateway.close()')
  expect(gateAt).toBeGreaterThan(-1)
  expect(computerTeardownAt).toBeGreaterThan(-1)
  expect(gateAt < computerTeardownAt).toBe(true)
})
