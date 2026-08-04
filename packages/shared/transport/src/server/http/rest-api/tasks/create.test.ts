/**
 * REST: POST /api/tasks contract tests.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/shared/transport/src/server/http/rest-api/tasks/create.test.ts
 */
import express from 'express'
import {
  createTestHarness,
  test,
  expect,
  describe
} from '../../../../../../test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../../test-utils/rest-harness.js'
import { spyTaskEvents } from '../../../../../../test-utils/event-spy.js'
import {
  ipcMain,
  __ipcEmitCalls,
  __resetIpcEmitCalls
} from '../../../../../../test-utils/mock-electron.js'
import { taskEvents, configureTaskRuntimeAdapters } from '@slayzone/task/server'
import { tmpdir } from 'node:os'
import { registerCreateTaskRoute } from './create.js'

const h = await createTestHarness()
// archive/cleanup ops resolve the data root via the task runtime adapter.
configureTaskRuntimeAdapters({ getDataRoot: () => tmpdir() })
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'P', '#000', '/tmp/p')

// Second project with CUSTOM columns: `slay tasks create --status` must resolve
// aliases against the target project's board, not a built-in list.
const customProjectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
  .run(
    customProjectId,
    'CUSTOMBOARD',
    '#000',
    null,
    JSON.stringify([
      { id: 'queue', label: 'Queue', color: 'gray', position: 0, category: 'unstarted' },
      { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
      { id: 'closed', label: 'Closed', color: 'green', position: 2, category: 'completed' }
    ])
  )

// Templates for the `template` (name | id prefix) ref resolution below.
const templateId = crypto.randomUUID()
h.db
  .prepare(
    `INSERT INTO task_templates (id, project_id, name, terminal_mode, default_status, default_priority)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
  .run(templateId, projectId, 'Bugfix', 'codex', 'in_progress', 2)
// Same NAME under a different project — proves template lookup is project-scoped.
h.db
  .prepare(`INSERT INTO task_templates (id, project_id, name) VALUES (?, ?, ?)`)
  .run(crypto.randomUUID(), customProjectId, 'Bugfix')

let notifyCount = 0
const app = express()
app.use(express.json())
registerCreateTaskRoute(app, {
  db: h.slayDb,
  taskBus: ipcMain,
  notifyRenderer: () => {
    notifyCount++
  }
})
const rest = await mountRestApp(app)

await describe('POST /api/tasks', () => {
  test('happy: 200 + task payload + DB row inserted', async () => {
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:created')
    notifyCount = 0
    const res = await rest.request<{
      ok: boolean
      data: { id: string; title: string; project_id: string }
    }>('POST', '/api/tasks', { projectId, title: 'Hello' })
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data.title).toBe('Hello')
    expect(res.body.data.project_id).toBe(projectId)
    const row = h.db.prepare('SELECT title FROM tasks WHERE id = ?').get(res.body.data.id) as {
      title: string
    }
    expect(row.title).toBe('Hello')
    expect(spy.calls.length).toBe(1)
    expect((spy.calls[0].payload as { taskId: string }).taskId).toBe(res.body.data.id)
    const createEmits = __ipcEmitCalls.filter((c) => c[0] === 'db:tasks:create:done')
    expect(createEmits.length).toBeGreaterThanOrEqual(1)
    expect(notifyCount).toBeGreaterThanOrEqual(1)
  })

  test('400: missing required field projectId', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', {
      title: 'no project'
    })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  test('400: missing required field title', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', {
      projectId
    })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  test('400: empty body', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', {})
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
  })

  test('400: priority out of range', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', {
      projectId,
      title: 'bad',
      priority: 99
    })
    expect(res.status).toBe(400)
  })

  test('happy: explicit status + priority preserved', async () => {
    const res = await rest.request<{ ok: boolean; data: { status: string; priority: number } }>(
      'POST',
      '/api/tasks',
      { projectId, title: 'Custom', status: 'todo', priority: 1 }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('todo')
    expect(res.body.data.priority).toBe(1)
  })
})

/**
 * The `slay tasks create` cutover: everything the CLI used to read the hub's
 * SQLite file for happens here now (project ref, status alias, template ref,
 * external-id dedupe), so `tasks create` works against a hub on another machine.
 */
await describe('POST /api/tasks — project reference', () => {
  test('`project` accepts a case-insensitive NAME substring', async () => {
    const res = await rest.request<{
      ok: boolean
      data: { id: string; project_id: string }
      project: { id: string; name: string }
    }>('POST', '/api/tasks', { project: 'customboard', title: 'ByName' })
    expect(res.status).toBe(200)
    expect(res.body.data.project_id).toBe(customProjectId)
    // The CLI prints the project NAME and must not read the DB to get it.
    expect(res.body.project.name).toBe('CUSTOMBOARD')
    expect(res.body.project.id).toBe(customProjectId)
  })

  test('`project` accepts a full id', async () => {
    const res = await rest.request<{ ok: boolean; data: { project_id: string } }>(
      'POST',
      '/api/tasks',
      { project: projectId, title: 'ById' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.project_id).toBe(projectId)
  })

  test('404: unknown project, with the CLI wording + the available list', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', {
      project: 'totally-not-a-project',
      title: 'x'
    })
    expect(res.status).toBe(404)
    expect(res.body.error.includes('No project matching "totally-not-a-project"')).toBe(true)
    expect(res.body.error.includes('CUSTOMBOARD')).toBe(true)
  })

  test('400: ambiguous project names', async () => {
    const a = crypto.randomUUID()
    const b = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(a, 'AmbOne', '#000')
    h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(b, 'AmbTwo', '#000')
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', {
      project: 'amb',
      title: 'x'
    })
    expect(res.status).toBe(400)
    expect(res.body.error.includes('Ambiguous project "amb"')).toBe(true)
    h.db.prepare('DELETE FROM projects WHERE id IN (?, ?)').run(a, b)
  })

  test('400: both project and projectId', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', {
      project: 'P',
      projectId,
      title: 'x'
    })
    expect(res.status).toBe(400)
  })

  test('`projectId` still works for existing callers (renderer / MCP)', async () => {
    const res = await rest.request<{ ok: boolean; data: { project_id: string } }>(
      'POST',
      '/api/tasks',
      { projectId, title: 'StillById' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.project_id).toBe(projectId)
  })
})

await describe('POST /api/tasks — status alias resolved hub-side', () => {
  test('a LABEL resolves against the project columns', async () => {
    const res = await rest.request<{ ok: boolean; data: { status: string } }>(
      'POST',
      '/api/tasks',
      { project: 'P', title: 'LabelStatus', status: 'In Progress' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('in_progress')
  })

  test('a CUSTOM column label resolves against THAT project', async () => {
    const res = await rest.request<{ ok: boolean; data: { status: string } }>(
      'POST',
      '/api/tasks',
      { project: 'CUSTOMBOARD', title: 'CustomStatus', status: 'Closed' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('closed')
  })

  test('400 (not a silent coercion to the default) for an unknown status', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', {
      project: 'P',
      title: 'BadStatus',
      status: 'nonsense'
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Unknown status "nonsense" for project "P".')
  })

  test("a built-in status not on a CUSTOM project's board is rejected", async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', {
      project: 'CUSTOMBOARD',
      title: 'WrongBoard',
      status: 'todo'
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Unknown status "todo" for project "CUSTOMBOARD".')
  })
})

await describe('POST /api/tasks — template reference resolved hub-side', () => {
  test('`template` by NAME applies the template defaults', async () => {
    const res = await rest.request<{
      ok: boolean
      data: { id: string; status: string; priority: number; terminal_mode: string }
    }>('POST', '/api/tasks', { project: 'P', title: 'TplByName', template: 'Bugfix' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('in_progress')
    expect(res.body.data.priority).toBe(2)
    expect(res.body.data.terminal_mode).toBe('codex')
  })

  test('`template` by id PREFIX applies the same template', async () => {
    const res = await rest.request<{ ok: boolean; data: { priority: number } }>(
      'POST',
      '/api/tasks',
      { project: 'P', title: 'TplByPrefix', template: templateId.slice(0, 8) }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.priority).toBe(2)
  })

  test('404: unknown template, with the CLI wording', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', {
      project: 'P',
      title: 'NoTpl',
      template: 'no-such-template'
    })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Template not found: "no-such-template"')
  })

  test('template lookup is scoped to the target project', async () => {
    // 'Bugfix' exists under BOTH projects; the CUSTOMBOARD one carries no
    // defaults, so resolving the wrong one would show up as priority 2.
    const res = await rest.request<{ ok: boolean; data: { priority: number } }>(
      'POST',
      '/api/tasks',
      { project: 'CUSTOMBOARD', title: 'TplScoped', template: 'Bugfix' }
    )
    expect(res.status).toBe(200)
    expect(res.body.data.priority).toBe(3)
  })
})

await describe('POST /api/tasks — external id written with the insert', () => {
  test('externalId + externalProvider land on the row the insert created', async () => {
    __resetIpcEmitCalls()
    const spy = spyTaskEvents(taskEvents, 'task:created')
    notifyCount = 0
    const res = await rest.request<{ ok: boolean; data: { id: string }; existing?: boolean }>(
      'POST',
      '/api/tasks',
      { project: 'P', title: 'Ext', externalId: 'ISSUE-1', externalProvider: 'linear' }
    )
    spy.stop()
    expect(res.status).toBe(200)
    expect(res.body.existing).toBe(undefined)
    const row = h.db
      .prepare('SELECT external_id, external_provider FROM tasks WHERE id = ?')
      .get(res.body.data.id) as { external_id: string; external_provider: string }
    expect(row.external_id).toBe('ISSUE-1')
    expect(row.external_provider).toBe('linear')
    // ONE change for the row, already carrying its external id — no follow-up
    // UPDATE behind the hub's back.
    expect(spy.calls.length).toBe(1)
    expect(notifyCount).toBe(1)
  })

  test('externalId with no provider stores a null provider', async () => {
    const res = await rest.request<{ ok: boolean; data: { id: string } }>('POST', '/api/tasks', {
      project: 'P',
      title: 'ExtNoProv',
      externalId: 'BARE-1'
    })
    expect(res.status).toBe(200)
    const row = h.db
      .prepare('SELECT external_id, external_provider FROM tasks WHERE id = ?')
      .get(res.body.data.id) as { external_id: string; external_provider: string | null }
    expect(row.external_id).toBe('BARE-1')
    expect(row.external_provider).toBeNull()
  })

  test('idempotent on (project, provider, external_id): returns the existing task', async () => {
    const first = await rest.request<{ ok: boolean; data: { id: string; title: string } }>(
      'POST',
      '/api/tasks',
      { project: 'P', title: 'Dedup', externalId: 'ISSUE-9', externalProvider: 'github' }
    )
    expect(first.status).toBe(200)

    const spy = spyTaskEvents(taskEvents, 'task:created')
    notifyCount = 0
    const second = await rest.request<{
      ok: boolean
      data: { id: string; title: string; status: string }
      existing?: boolean
      project: { name: string }
    }>('POST', '/api/tasks', {
      project: 'P',
      title: 'Dedup AGAIN',
      externalId: 'ISSUE-9',
      externalProvider: 'github'
    })
    spy.stop()
    expect(second.status).toBe(200)
    expect(second.body.existing).toBe(true)
    expect(second.body.data.id).toBe(first.body.data.id)
    // The EXISTING title, so the CLI's `Exists:` line names the real task.
    expect(second.body.data.title).toBe('Dedup')
    expect(second.body.project.name).toBe('P')
    // Nothing was created: no event, no notify, no second row.
    expect(spy.calls.length).toBe(0)
    expect(notifyCount).toBe(0)
    const count = h.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE external_id = 'ISSUE-9'`)
      .get() as { n: number }
    expect(count.n).toBe(1)
  })

  test('dedupe also matches when the provider is NULL', async () => {
    // The CLI compared `external_provider = :provider` with a null bind, which
    // never matches in SQL — and SQLite treats NULLs as distinct in a UNIQUE
    // index, so a provider-less `--external-id` silently created a duplicate on
    // every re-run. The hub compares with `IS`, so the tuple dedupes for real.
    const before = h.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE external_id = 'BARE-1'`)
      .get() as { n: number }
    expect(before.n).toBe(1)
    const res = await rest.request<{
      ok: boolean
      data: { title: string }
      existing?: boolean
    }>('POST', '/api/tasks', { project: 'P', title: 'BareAgain', externalId: 'BARE-1' })
    expect(res.status).toBe(200)
    expect(res.body.existing).toBe(true)
    expect(res.body.data.title).toBe('ExtNoProv')
    const after = h.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE external_id = 'BARE-1'`)
      .get() as { n: number }
    expect(after.n).toBe(1)
  })

  test('the same external id in a DIFFERENT project creates a new task', async () => {
    const res = await rest.request<{ ok: boolean; data: { id: string }; existing?: boolean }>(
      'POST',
      '/api/tasks',
      {
        project: 'CUSTOMBOARD',
        title: 'OtherProject',
        externalId: 'ISSUE-9',
        externalProvider: 'github'
      }
    )
    expect(res.status).toBe(200)
    expect(res.body.existing).toBe(undefined)
    const count = h.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE external_id = 'ISSUE-9'`)
      .get() as { n: number }
    expect(count.n).toBe(2)
  })
})

await describe('POST /api/tasks — priority wording', () => {
  test('400 with the CLI wording for an out-of-range priority', async () => {
    const res = await rest.request<{ ok: boolean; error: string }>('POST', '/api/tasks', {
      project: 'P',
      title: 'BadPrio',
      priority: 9
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Priority must be 1-5.')
  })
})

await rest.close()
h.cleanup()
