/**
 * attention-push: when the hub flags a task "needs attention" (an agent's turn ended,
 * `@slayzone/task` attention.ts), the phones of the person whose agent it is get one
 * notification through the push service. Tested against the in-memory harness DB and
 * a fake push client.
 */
import crypto from 'node:crypto'
import { beforeEach, expect, test } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import type { AttentionPushData } from '../index.js'
import { createAttentionPush } from './attention-push.js'
import { registerDevice, setDevicePrefs } from './device-store.js'
import type {
  ExpoPushClient,
  ExpoPushMessage,
  ExpoPushReceipt,
  ExpoPushTicket
} from './expo-client.js'

const h = await createTestHarness()
const db = h.slayDb
const token = (n: string) => `ExponentPushToken[${n}]`

interface Fake extends ExpoPushClient {
  sent: ExpoPushMessage[][]
  tickets: (m: ExpoPushMessage) => ExpoPushTicket
  receiptOf: Record<string, ExpoPushReceipt>
}
let client: Fake
let now = 0
let scheduled: Array<() => void> = []
let enabled = true
const events: Array<{ event: string; payload?: unknown }> = []
let ticketN = 0

const push = () =>
  createAttentionPush({
    db,
    client,
    enabled: () => enabled,
    now: () => now,
    debounceMs: 30_000,
    schedule: (fn) => {
      scheduled.push(fn)
    },
    record: (e) => events.push(e)
  })

function newProject(owner: string | null): string {
  const id = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, owner_user_id) VALUES (?, ?, ?, ?)')
    .run(id, 'Website', '#000', owner)
  return id
}
function newTask(projectId: string, title = 'Fix login bug'): string {
  const id = crypto.randomUUID()
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, status, priority, "order") VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, projectId, title, 'in_progress', 3, 0)
  return id
}
function newTab(taskId: string, tabId: string, owner: string | null): void {
  h.db
    .prepare(
      'INSERT INTO terminal_tabs (id, task_id, mode, position, owner_user_id) VALUES (?, ?, ?, ?, ?)'
    )
    .run(tabId, taskId, 'claude-code', 0, owner)
}

beforeEach(() => {
  h.db.prepare('DELETE FROM push_devices').run()
  ticketN = 0
  client = {
    sent: [],
    receiptOf: {},
    tickets: () => ({ status: 'ok', id: `ticket-${++ticketN}` }),
    async send(messages) {
      this.sent.push([...messages])
      return messages.map((m) => this.tickets(m))
    },
    async receipts(ids) {
      return Object.fromEntries(
        ids.filter((id) => this.receiptOf[id]).map((id) => [id, this.receiptOf[id]])
      )
    }
  }
  now += 3_600_000
  scheduled = []
  enabled = true
  events.length = 0
})

test("a finished turn notifies the tab owner's phones, with what a tap needs", async () => {
  const projectId = newProject('owner')
  const taskId = newTask(projectId)
  newTab(taskId, 'tab-2', 'alice')
  await registerDevice(db, 'alice', { deviceId: 'p', token: token('alice'), hubRef: 'hub-a' })
  await registerDevice(db, 'owner', { deviceId: 'p', token: token('owner'), hubRef: 'hub-a' })

  await push().onAttentionSet(`${taskId}:tab-2`, 'idle')

  expect(client.sent).toHaveLength(1)
  const [msg] = client.sent[0]
  expect(msg).toMatchObject({
    to: token('alice'),
    title: 'Fix login bug',
    body: 'Website · Ready for review',
    sound: 'default'
  })
  expect(msg.data).toEqual({
    kind: 'attention',
    state: 'ready',
    taskId,
    projectId,
    hubRef: 'hub-a'
  } satisfies AttentionPushData)
})

test('an error says so, and only reaches phones that want errors', async () => {
  const taskId = newTask(newProject('owner'))
  newTab(taskId, 'tab', 'alice')
  await registerDevice(db, 'alice', { deviceId: 'p1', token: token('1'), hubRef: 'h' })
  await registerDevice(db, 'alice', { deviceId: 'p2', token: token('2'), hubRef: 'h' })
  await setDevicePrefs(db, 'alice', 'p2', { errors: false })

  await push().onAttentionSet(`${taskId}:tab`, 'error')

  expect(client.sent[0].map((m) => m.to)).toEqual([token('1')])
  expect(client.sent[0][0].body).toBe('Website · Error')
  expect((client.sent[0][0].data as AttentionPushData).state).toBe('error')
})

test('the main tab (no row yet) falls back to the project owner', async () => {
  const taskId = newTask(newProject('owner'))
  await registerDevice(db, 'owner', { deviceId: 'p', token: token('owner'), hubRef: 'h' })
  await push().onAttentionSet(`${taskId}:${taskId}`, 'idle')
  expect(client.sent[0].map((m) => m.to)).toEqual([token('owner')])
})

test('phones registered on a hub without login (user "") are always told', async () => {
  const taskId = newTask(newProject(null))
  await registerDevice(db, '', { deviceId: 'p', token: token('solo'), hubRef: 'h' })
  await push().onAttentionSet(`${taskId}:${taskId}`, 'idle')
  expect(client.sent[0].map((m) => m.to)).toEqual([token('solo')])
})

test('one task notifies at most once per debounce window', async () => {
  const taskId = newTask(newProject('owner'))
  await registerDevice(db, 'owner', { deviceId: 'p', token: token('o'), hubRef: 'h' })
  const p = push()
  await p.onAttentionSet(`${taskId}:${taskId}`, 'idle')
  now += 10_000
  await p.onAttentionSet(`${taskId}:${taskId}`, 'idle')
  expect(client.sent).toHaveLength(1)
  now += 30_000
  await p.onAttentionSet(`${taskId}:${taskId}`, 'idle')
  expect(client.sent).toHaveLength(2)
})

test('nothing is sent with the switch off, or with no phone to tell', async () => {
  const taskId = newTask(newProject('owner'))
  await push().onAttentionSet(`${taskId}:${taskId}`, 'idle')
  expect(client.sent).toHaveLength(0)
  await registerDevice(db, 'owner', { deviceId: 'p', token: token('o'), hubRef: 'h' })
  enabled = false
  await push().onAttentionSet(`${taskId}:${taskId}`, 'idle')
  expect(client.sent).toHaveLength(0)
})

test('a phone Expo calls unregistered is forgotten, from the ticket or the receipt', async () => {
  const taskId = newTask(newProject('owner'))
  await registerDevice(db, 'owner', { deviceId: 'gone', token: token('gone'), hubRef: 'h' })
  await registerDevice(db, 'owner', { deviceId: 'late', token: token('late'), hubRef: 'h' })
  client.tickets = (m) =>
    m.to === token('gone')
      ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
      : { status: 'ok', id: 'ticket-late' }
  client.receiptOf['ticket-late'] = {
    status: 'error',
    message: 'uninstalled',
    details: { error: 'DeviceNotRegistered' }
  }

  await push().onAttentionSet(`${taskId}:${taskId}`, 'idle')
  const left = () =>
    (
      h.db.prepare('SELECT device_id FROM push_devices ORDER BY device_id').all() as {
        device_id: string
      }[]
    ).map((r) => r.device_id)
  expect(left()).toEqual(['late'])
  expect(scheduled).toHaveLength(1)
  scheduled[0]()
  await new Promise((r) => setTimeout(r, 0))
  expect(left()).toEqual([])
})

test('a push service failure is recorded, never thrown', async () => {
  const taskId = newTask(newProject('owner'))
  await registerDevice(db, 'owner', { deviceId: 'p', token: token('o'), hubRef: 'h' })
  client.send = async () => {
    throw new Error('503 from push service')
  }
  await expect(push().onAttentionSet(`${taskId}:${taskId}`, 'idle')).resolves.toBeUndefined()
  expect(events.map((e) => e.event)).toContain('push.failed')
})
