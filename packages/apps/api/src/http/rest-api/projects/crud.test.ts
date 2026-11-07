/**
 * REST: /api/projects CRUD contract tests.
 */
import { afterAll, describe, expect, test } from 'vitest'
import express from 'express'
import { createTestHarness } from '../../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import { registerProjectsCrudRoutes } from './crud.js'

const h = await createTestHarness()

const existingId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(existingId, 'Existing', '#000000', '/tmp/existing')
h.db
  .prepare(
    `INSERT INTO computers (id, name, platform, version, capabilities_json, last_seen_at, created_at)
     VALUES ('cOther', 'other-box', 'linux-x64', '0', '{}', 0, 1)`
  )
  .run()

let notifyCount = 0
const app = express()
app.use(express.json())
registerProjectsCrudRoutes(app, {
  db: h.slayDb,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

interface Project {
  id: string
  name: string
  color: string
  path: string | null
}
type OneResponse = { ok: boolean; data: Project; error?: string }

let createdId = ''

describe('/api/projects CRUD', () => {
  test('POST: creates a project with defaults + notifies', async () => {
    notifyCount = 0
    const res = await rest.request<OneResponse>('POST', '/api/projects', {
      name: 'Fresh',
      path: '/tmp/fresh'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Fresh')
    expect(res.body.data.color).toBe('#3b82f6')
    expect(res.body.data.path).toBe('/tmp/fresh')
    expect(notifyCount).toBe(1)
    createdId = res.body.data.id
    const row = h.db.prepare('SELECT name FROM projects WHERE id = ?').get(createdId) as {
      name: string
    }
    expect(row.name).toBe('Fresh')
  })

  test('POST 400: missing name', async () => {
    const res = await rest.request<OneResponse>('POST', '/api/projects', { color: '#abcdef' })
    expect(res.status).toBe(400)
  })

  test('POST 400: invalid color', async () => {
    const res = await rest.request<OneResponse>('POST', '/api/projects', {
      name: 'BadColor',
      color: 'not-a-hex'
    })
    expect(res.status).toBe(400)
  })

  test('PATCH: updates name + color by name substring', async () => {
    const res = await rest.request<OneResponse>('PATCH', '/api/projects/Existing', {
      name: 'Renamed',
      color: '#ff0000'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(existingId)
    expect(res.body.data.name).toBe('Renamed')
    expect(res.body.data.color).toBe('#ff0000')
  })

  test('PATCH: clears path with null', async () => {
    const res = await rest.request<OneResponse>('PATCH', `/api/projects/${existingId}`, {
      path: null
    })
    expect(res.status).toBe(200)
    expect(res.body.data.path).toBeNull()
  })

  test('PATCH: computerId makes that computer the project default', async () => {
    const res = await rest.request<OneResponse>('PATCH', `/api/projects/${existingId}`, {
      computerId: 'cOther'
    })
    expect(res.status).toBe(200)
    const row = h.db
      .prepare('SELECT default_computer_id FROM projects WHERE id = ?')
      .get(existingId) as { default_computer_id: string | null }
    expect(row.default_computer_id).toBe('cOther')
  })

  test('PATCH 400: unknown computerId changes nothing', async () => {
    const res = await rest.request<OneResponse>('PATCH', `/api/projects/${existingId}`, {
      computerId: 'no-such-computer',
      name: 'ShouldNotApply'
    })
    expect(res.status).toBe(400)
    const row = h.db
      .prepare('SELECT name, default_computer_id FROM projects WHERE id = ?')
      .get(existingId) as { name: string; default_computer_id: string | null }
    expect(row).toEqual({ name: 'Renamed', default_computer_id: 'cOther' })
  })

  test('PATCH 400: no fields', async () => {
    const res = await rest.request<OneResponse>('PATCH', `/api/projects/${existingId}`, {})
    expect(res.status).toBe(400)
  })

  test('PATCH: addresses a project by unique id prefix (the 8 chars `slay projects list` prints)', async () => {
    const res = await rest.request<OneResponse>(
      'PATCH',
      `/api/projects/${existingId.slice(0, 8)}`,
      {
        color: '#00ff00'
      }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(existingId)
    expect(res.body.data.color).toBe('#00ff00')
  })

  test('PATCH: a name substring still wins over an id prefix', async () => {
    // A project whose NAME contains another project's id prefix: names resolved first,
    // as they always have, so the prefix fallback never changes an existing answer.
    const prefix = existingId.slice(0, 8)
    const namedId = crypto.randomUUID()
    h.db
      .prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)')
      .run(namedId, `named-${prefix}`, '#000000')
    const res = await rest.request<OneResponse>('PATCH', `/api/projects/${prefix}`, {
      color: '#0000ff'
    })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(namedId)
    h.db.prepare('DELETE FROM projects WHERE id = ?').run(namedId)
  })

  test('PATCH 400: ambiguous id prefix', async () => {
    const a = `abcabc01-${crypto.randomUUID().slice(9)}`
    const b = `abcabc02-${crypto.randomUUID().slice(9)}`
    for (const [id, name] of [
      [a, 'PrefixOne'],
      [b, 'PrefixTwo']
    ])
      h.db
        .prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)')
        .run(id, name, '#000000')
    const res = await rest.request<OneResponse>('PATCH', '/api/projects/abcabc0', {
      color: '#111111'
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('Ambiguous project "abcabc0"')
    h.db.prepare('DELETE FROM projects WHERE id IN (?, ?)').run(a, b)
  })

  test('PATCH 404: unknown project', async () => {
    const res = await rest.request<OneResponse>('PATCH', '/api/projects/definitely-not-a-project', {
      name: 'x'
    })
    expect(res.status).toBe(404)
  })
})

afterAll(async () => {
  await rest.close()
  h.cleanup()
})
