/**
 * Tab-flag recorder wiring — the seam that decides whether a restart restores
 * your agents.
 *
 * The regression this pins: `terminal_tabs.was_spawned` is written by
 * `spawnedSetter` inside pty-manager/chat-transport-manager, and that setter was
 * installed ONLY by the Electron host (`apps/app/src/main/index.ts`). When the
 * pty runtime moved to the side-car (slice 9) and spawning moved to the runner,
 * the host stopped owning any session — so every `spawnedSetter?.(…)` became a
 * no-op, `was_spawned` stayed 0 forever, and `listAutoRestoreTasks` had nothing
 * to restore. Same orphaning that killed idle-close and the warm pool.
 *
 * So this asserts the REAL module-global state of `@slayzone/terminal/server`
 * (not injected spies): after `wireTabFlagRecorders(db)` the pty AND chat
 * managers both hold a recorder, and driving it round-trips through
 * `markTabSpawned` into the real `terminal_tabs` row.
 *
 * Plus a narrow source check that the hub's `stop()` sets the shutdown gate
 * BEFORE tearing the runner gateway down — the gate is what keeps a quit-time
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
  getPtySpawnedTabRecorder,
  getChatSpawnedTabRecorder,
  setPtySpawnedTabRecorder,
  setChatSpawnedTabRecorder
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

const wasSpawnedOf = (id: string): number =>
  (h.db.prepare('SELECT was_spawned FROM terminal_tabs WHERE id = ?').get(id) as
    | { was_spawned: number }
    | undefined
  )?.was_spawned ?? -1

test('tab-flag recorders: unwired by default (the orphaned state)', () => {
  setPtySpawnedTabRecorder(null)
  setChatSpawnedTabRecorder(null)
  expect(getPtySpawnedTabRecorder()).toBe(null)
  expect(getChatSpawnedTabRecorder()).toBe(null)
})

test('tab-flag recorders: wireTabFlagRecorders installs on BOTH pty and chat', () => {
  wireTabFlagRecorders(h.slayDb)
  const pty = getPtySpawnedTabRecorder()
  const chat = getChatSpawnedTabRecorder()
  expect(typeof pty).toBe('function')
  expect(typeof chat).toBe('function')
  // One recorder, two managers — a chat agent and a pty agent must flip the
  // same column or restore is half-broken depending on the task's mode.
  expect(pty).toBe(chat)
})

test('tab-flag recorders: installed recorder round-trips into terminal_tabs', async () => {
  await ensureMainTab(h.slayDb, taskId, 'claude-code')
  expect(wasSpawnedOf(taskId)).toBe(0)

  const record = getPtySpawnedTabRecorder()!
  record(taskId, true)
  await new Promise((r) => setTimeout(r, 20))
  expect(wasSpawnedOf(taskId)).toBe(1)

  record(taskId, false)
  await new Promise((r) => setTimeout(r, 20))
  expect(wasSpawnedOf(taskId)).toBe(0)
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

test('hub stop(): sets the terminal shutdown gate before tearing down runners', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, 'server.ts'), 'utf8')
  const stopBody = src.slice(src.indexOf('stop: async () => {'))
  const gateAt = stopBody.indexOf('beginTerminalShutdown()')
  const runnerTeardownAt = stopBody.indexOf('runnerGateway.close()')
  expect(gateAt).toBeGreaterThan(-1)
  expect(runnerTeardownAt).toBeGreaterThan(-1)
  expect(gateAt < runnerTeardownAt).toBe(true)
})
