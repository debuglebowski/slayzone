/**
 * REST: the task layout routes (docs/plans/panel-model.md step 13) —
 * GET/PUT /api/tasks/:id/layout, POST/PATCH/DELETE /api/tasks/:id/panels.
 * Run with: ./node_modules/.bin/vitest run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/api/src/http/rest-api/tasks/layout.test.ts
 */
import express from 'express'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { taskEvents } from '@slayzone/task/server'
import type { TaskLayout, TaskLayoutChangedEvent } from '@slayzone/task-contracts'
import { isInstanceVisible, PARKED_SLOT_ID } from '@slayzone/task-contracts'
import { createTestHarness } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { registerTaskLayoutRoutes } from './layout.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Alpha', '#000', '/tmp/alpha')

let taskId = ''
let notified = 0
beforeEach(() => {
  taskId = `44444444-${crypto.randomUUID().slice(9)}`
  h.db
    .prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)')
    .run(taskId, projectId, 'Task')
  h.db.prepare('DELETE FROM settings WHERE key = ?').run('agent_may_change_layout')
})

const app = express()
app.use(express.json())
registerTaskLayoutRoutes(app, { db: h.slayDb, notifyRenderer: () => void notified++ })
const rest = await mountRestApp(app)

type Ok<T> = { ok: true; data: T }
type Err = { ok: false; error: string; code?: string }
type ChangeData = {
  taskId: string
  layout: TaskLayout
  instanceId?: string
  existing?: boolean
  parked?: string[]
}

/** A request as a task terminal's `slay` sends it (an agent session). */
async function asAgent<T>(method: string, path: string, body?: unknown) {
  const res = await fetch(`${rest.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-slayzone-caller': 'agent' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: res.status, body: (await res.json()) as T }
}

const storedRow = () =>
  h.db.prepare('SELECT panel_layout, panel_visibility FROM tasks WHERE id = ?').get(taskId) as {
    panel_layout: string | null
    panel_visibility: string | null
  }

function captureEvents(): { events: TaskLayoutChangedEvent[]; stop: () => void } {
  const events: TaskLayoutChangedEvent[] = []
  const on = (e: TaskLayoutChangedEvent): void => void events.push(e)
  taskEvents.on('task:layout-changed', on)
  return { events, stop: () => taskEvents.off('task:layout-changed', on) }
}

describe('GET /api/tasks/:id/layout', () => {
  test('a task without a stored layout reads as derived Classic, with the layouts it can switch to', async () => {
    const res = await rest.request<
      Ok<{
        layout: TaskLayout
        definitions: Array<{ id: string }>
        agentMayChangeLayout: boolean
      }>
    >('GET', `/api/tasks/${taskId.slice(0, 13)}/layout`)
    expect(res.status).toBe(200)
    expect(res.body.data.layout.layoutId).toBe('classic')
    expect(res.body.data.layout.instances.terminal?.kind).toBe('agent')
    expect(res.body.data.definitions.map((d) => d.id)).toContain('focus')
    expect(res.body.data.agentMayChangeLayout).toBe(true)
  })

  test('404 for an unknown task', async () => {
    const res = await rest.request<Err>('GET', '/api/tasks/ffffffff/layout')
    expect(res.status).toBe(404)
  })
})

describe('POST /api/tasks/:id/panels', () => {
  test('Classic: a hidden primary is shown, not added', async () => {
    const res = await rest.request<Ok<ChangeData>>('POST', `/api/tasks/${taskId}/panels`, {
      kind: 'browser'
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ instanceId: 'browser', existing: true })
    expect(isInstanceVisible(res.body.data.layout, 'browser')).toBe(true)
    expect(
      Object.keys(res.body.data.layout.instances).filter((id) => id.startsWith('browser'))
    ).toEqual(['browser'])
  })

  test('with the primary visible: opens a panel as a new column, bumps the rev and dual-writes', async () => {
    await rest.request('POST', `/api/tasks/${taskId}/panels`, { kind: 'browser' })
    const before = notified
    const res = await rest.request<Ok<ChangeData>>('POST', `/api/tasks/${taskId}/panels`, {
      kind: 'browser'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.existing).toBeUndefined()
    const id = res.body.data.instanceId as string
    expect(id).toMatch(/^browser:/)
    expect(isInstanceVisible(res.body.data.layout, id)).toBe(true)
    expect(res.body.data.layout.rev).toBeGreaterThan(0)
    const row = storedRow()
    expect(JSON.parse(row.panel_layout as string).instances[id].kind).toBe('browser')
    expect(row.panel_visibility).not.toBeNull()
    expect(notified).toBeGreaterThan(before)
  })

  test('an agent panel gets its first terminal group', async () => {
    const res = await rest.request<Ok<ChangeData>>('POST', `/api/tasks/${taskId}/panels`, {
      kind: 'terminal',
      name: 'Logs'
    })
    expect(res.status).toBe(200)
    const inst = res.body.data.layout.instances[res.body.data.instanceId as string]
    expect(inst.name).toBe('Logs')
    const groups = inst.settings.terminalGroupIds as string[]
    expect(groups).toHaveLength(1)
    const tab = h.db
      .prepare('SELECT task_id, mode FROM terminal_tabs WHERE group_id = ?')
      .get(groups[0]) as { task_id: string; mode: string }
    expect(tab).toEqual({ task_id: taskId, mode: 'terminal' })
  })

  test('a tab next to a panel: placement names the panel, not its group', async () => {
    const res = await rest.request<Ok<ChangeData>>('POST', `/api/tasks/${taskId}/panels`, {
      kind: 'web',
      settings: { url: 'example.com' },
      placement: { type: 'tab', slotId: 'terminal' }
    })
    expect(res.status).toBe(200)
    const layout = res.body.data.layout
    const id = res.body.data.instanceId as string
    expect(layout.instances[id].settings.url).toBe('https://example.com/')
    const slot = layout.columns.flatMap((c) => c.slots).find((s) => s.id === 'terminal')
    expect(slot?.tabs.map((t) => t.instanceId)).toEqual(['terminal', id])
  })

  test('a one-per-task kind the task has is shown, not added', async () => {
    const res = await rest.request<Ok<ChangeData>>('POST', `/api/tasks/${taskId}/panels`, {
      kind: 'settings'
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ instanceId: 'settings', existing: true })
  })

  test.each([
    [{ kind: 'nope' }, /kind/],
    [{ kind: 'browser', extra: 1 }, /extra|Unrecognized/i],
    [{ kind: 'web', settings: { url: 'not a url' } }, /usable URL/],
    [{ kind: 'agent', settings: { terminalGroupIds: ['x'] } }, /managed by SlayZone/],
    [{ kind: 'artifact', settings: { artifactId: 5 } }, /settings/],
    [{ kind: 'browser', placement: { type: 'tab', slotId: 'missing' } }, /Unknown group or panel/]
  ])('400 for %j', async (body, message) => {
    const res = await rest.request<Err>('POST', `/api/tasks/${taskId}/panels`, body)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(message)
    expect(storedRow().panel_layout).toBeNull()
  })
})

describe('PATCH / DELETE /api/tasks/:id/panels/:instanceId', () => {
  test('hide, show, rename and settings', async () => {
    const opened = await rest.request<Ok<ChangeData>>('POST', `/api/tasks/${taskId}/panels`, {
      kind: 'web',
      settings: { url: 'https://a.test' }
    })
    const id = encodeURIComponent(opened.body.data.instanceId as string)
    let res = await rest.request<Ok<ChangeData>>('PATCH', `/api/tasks/${taskId}/panels/${id}`, {
      hidden: true,
      name: 'Docs',
      settings: { url: 'b.test' }
    })
    expect(res.status).toBe(200)
    let inst = res.body.data.layout.instances[opened.body.data.instanceId as string]
    expect(inst).toMatchObject({ name: 'Docs', settings: { url: 'https://b.test/' } })
    expect(isInstanceVisible(res.body.data.layout, inst.id)).toBe(false)

    res = await rest.request<Ok<ChangeData>>('PATCH', `/api/tasks/${taskId}/panels/${id}`, {
      hidden: false,
      name: null
    })
    inst = res.body.data.layout.instances[inst.id]
    expect(inst.name).toBeUndefined()
    expect(isInstanceVisible(res.body.data.layout, inst.id)).toBe(true)
  })

  test('PATCH: 404 unknown panel, 400 nothing to change', async () => {
    const missing = await rest.request<Err>('PATCH', `/api/tasks/${taskId}/panels/nope`, {
      hidden: true
    })
    expect(missing.status).toBe(404)
    expect(missing.body.error).toMatch(/Panel not found: nope/)
    const empty = await rest.request<Err>('PATCH', `/api/tasks/${taskId}/panels/terminal`, {})
    expect(empty.status).toBe(400)
  })

  test('DELETE removes a secondary panel and only hides a primary one', async () => {
    // The first shows Classic's hidden primary Git panel; the second is a new one.
    await rest.request('POST', `/api/tasks/${taskId}/panels`, { kind: 'git' })
    const opened = await rest.request<Ok<ChangeData>>('POST', `/api/tasks/${taskId}/panels`, {
      kind: 'git'
    })
    const id = opened.body.data.instanceId as string
    const { events, stop } = captureEvents()
    const closed = await rest.request<Ok<ChangeData>>(
      'DELETE',
      `/api/tasks/${taskId}/panels/${encodeURIComponent(id)}`
    )
    expect(closed.status).toBe(200)
    expect(closed.body.data.layout.instances[id]).toBeUndefined()
    expect(events.at(-1)).toMatchObject({ taskId, origin: 'user' })
    expect(events.at(-1)?.removed.map((i) => i.id)).toEqual([id])

    const primary = await rest.request<Ok<ChangeData>>(
      'DELETE',
      `/api/tasks/${taskId}/panels/terminal`
    )
    stop()
    expect(primary.body.data.layout.instances.terminal).toBeDefined()
    expect(isInstanceVisible(primary.body.data.layout, 'terminal')).toBe(false)
    expect(JSON.parse(storedRow().panel_visibility as string).terminal).toBe(false)
  })
})

describe('PUT /api/tasks/:id/layout', () => {
  test('switches to a layout definition by id or name', async () => {
    let res = await rest.request<Ok<ChangeData>>('PUT', `/api/tasks/${taskId}/layout`, {
      layoutId: 'focus'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.layout.layoutId).toBe('focus')
    res = await rest.request<Ok<ChangeData>>('PUT', `/api/tasks/${taskId}/layout`, {
      layoutId: 'CLASSIC'
    })
    expect(res.body.data.layout.layoutId).toBe('classic')
  })

  test('400 for an unknown layout, an invalid layout, or both fields', async () => {
    const unknown = await rest.request<Err>('PUT', `/api/tasks/${taskId}/layout`, {
      layoutId: 'zzz'
    })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toMatch(/Unknown layout "zzz"\. Layouts: classic/)
    const invalid = await rest.request<Err>('PUT', `/api/tasks/${taskId}/layout`, {
      layout: { columns: 'no' }
    })
    expect(invalid.status).toBe(400)
    const both = await rest.request<Err>('PUT', `/api/tasks/${taskId}/layout`, {
      layoutId: 'focus',
      layout: {}
    })
    expect(both.status).toBe(400)
  })

  test('a whole layout replaces the tree; the primary agent it lacks is parked, not dropped', async () => {
    const res = await rest.request<Ok<ChangeData>>('PUT', `/api/tasks/${taskId}/layout`, {
      layout: {
        layoutId: 'mine',
        columns: [
          {
            id: 'c1',
            size: { unit: 'fr', value: 1 },
            slots: [
              {
                id: 's1',
                weight: 1,
                activeInstanceId: 'diff',
                tabs: [{ instanceId: 'diff' }]
              }
            ]
          }
        ],
        instances: { diff: { id: 'diff', kind: 'git', settings: {} } }
      }
    })
    expect(res.status).toBe(200)
    const layout = res.body.data.layout
    expect(layout.layoutId).toBe('mine')
    expect(isInstanceVisible(layout, 'diff')).toBe(true)
    expect(res.body.data.parked).toEqual(['terminal'])
    const parked = layout.columns.flatMap((c) => c.slots).find((s) => s.id === PARKED_SLOT_ID)
    expect(parked?.tabs).toEqual([{ instanceId: 'terminal', hidden: true, parked: true }])
  })
})

describe('agent_may_change_layout', () => {
  test("on (default): an agent's change goes through and is marked for Undo", async () => {
    const { events, stop } = captureEvents()
    const res = await asAgent<Ok<ChangeData>>('POST', `/api/tasks/${taskId}/panels`, {
      kind: 'processes'
    })
    stop()
    expect(res.status).toBe(200)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ taskId, origin: 'agent', rev: res.body.data.layout.rev })
    expect(events[0].before.instances.processes).toBeDefined()
    expect(events[0].before.rev).toBeLessThan(events[0].rev)
  })

  test("off: every agent write is refused with 403 layout_locked; reads and the user's own writes are not", async () => {
    h.db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run('agent_may_change_layout', '0')
    const writes: Array<[string, string, unknown]> = [
      ['POST', `/api/tasks/${taskId}/panels`, { kind: 'browser' }],
      ['PUT', `/api/tasks/${taskId}/layout`, { layoutId: 'focus' }],
      ['PATCH', `/api/tasks/${taskId}/panels/terminal`, { hidden: true }],
      ['DELETE', `/api/tasks/${taskId}/panels/terminal`, undefined]
    ]
    for (const [method, path, body] of writes) {
      const res = await asAgent<Err>(method, path, body)
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('layout_locked')
    }
    expect(storedRow().panel_layout).toBeNull()

    const read = await asAgent<Ok<{ agentMayChangeLayout: boolean }>>(
      'GET',
      `/api/tasks/${taskId}/layout`
    )
    expect(read.status).toBe(200)
    expect(read.body.data.agentMayChangeLayout).toBe(false)

    const mine = await rest.request<Ok<ChangeData>>('POST', `/api/tasks/${taskId}/panels`, {
      kind: 'browser'
    })
    expect(mine.status).toBe(200)
  })
})

afterAll(async () => {
  await rest.close()
  h.cleanup()
})
