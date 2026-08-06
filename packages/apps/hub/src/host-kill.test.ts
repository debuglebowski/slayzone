/**
 * Host-kill timestamp: the side-car must stamp `provider_config.lastPtyKilledAt`.
 *
 * WHAT THIS PINS: killing a task's agents records *when* it happened, and the
 * revive flow reads that stamp to choose between resuming a hot session and
 * starting a fresh conversation (COLD_RESPAWN_MS). Get it wrong and revive
 * silently picks the wrong branch.
 *
 * The handler was registered by the ELECTRON HOST (`main/index.ts`) against a
 * `pty-manager` module singleton in the host's process. But the pty runtime moved
 * to the side-car in slice 9 — `onHostKillHandler` fires in whichever process owns
 * the sessions, and the host owns none. So in local mode the stamp was never
 * written. Same orphaning that killed idle-close, the warm pool and `was_spawned`.
 *
 * `setOnHostKillHandler` is exported from `@slayzone/terminal/server` and needs no
 * Electron; the only reason this lived on the host is that the `db` handle did.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *     --experimental-loader ./packages/shared/test-utils/loader.ts \
 *     packages/apps/hub/src/host-kill.test.ts
 */
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../shared/test-utils/ipc-harness.js'
import { wireHostKillStamp } from './host-kill.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')

function seedTask(terminalMode: string | null, providerConfig = '{}'): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order", terminal_mode, provider_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, projectId, 'T', 'inbox', 3, 0, terminalMode, providerConfig)
  return id
}

const providerConfigOf = (id: string): Record<string, { lastPtyKilledAt?: number } & Record<string, unknown>> => {
  const row = h.db.prepare('SELECT provider_config FROM tasks WHERE id = ?').get(id) as
    | { provider_config: string | null }
    | undefined
  return row?.provider_config ? JSON.parse(row.provider_config) : {}
}

/**
 * Install the stamp with a capturing setter instead of the real module singleton,
 * and hand back the handler pty-manager would have called.
 */
function installed(): (taskId: string) => Promise<void> {
  let captured: ((taskId: string) => void) | null = null
  wireHostKillStamp(h.slayDb, (fn) => {
    captured = fn
  })
  if (!captured) throw new Error('wireHostKillStamp registered no handler')
  return captured as unknown as (taskId: string) => Promise<void>
}

test('stamps lastPtyKilledAt under the task’s terminal_mode', async () => {
  const taskId = seedTask('claude-code')
  await installed()(taskId)
  expect(typeof providerConfigOf(taskId)['claude-code']?.lastPtyKilledAt).toBe('number')
})

test('no terminal_mode → nothing written', async () => {
  const taskId = seedTask(null)
  await installed()(taskId)
  expect(Object.keys(providerConfigOf(taskId)).length).toBe(0)
})

test('preserves unrelated provider_config keys', async () => {
  const taskId = seedTask('codex', JSON.stringify({ codex: { conversationId: 'abc' } }))
  await installed()(taskId)
  const cfg = providerConfigOf(taskId)
  expect(cfg.codex.conversationId).toBe('abc')
  expect(typeof cfg.codex.lastPtyKilledAt).toBe('number')
})
