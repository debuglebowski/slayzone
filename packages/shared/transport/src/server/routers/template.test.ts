/**
 * template router contract tests via tRPC `createCaller` against the harness DB.
 * The template store is electron-free and imported directly by the router.
 * Ports the full coverage from the legacy template IPC-handler test
 * (domains/task/src/electron/template-handlers.test.ts): template CRUD +
 * default handling, template APPLICATION on task creation (via taskRouter), and
 * task-update round-trips of template-like fields.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import type { CreateTaskTemplateInput, UpdateTaskTemplateInput } from '@slayzone/task/shared'
import { templateRouter } from './template.js'
import { taskRouter } from './task.js'
import { setTaskDeps } from '../app-deps.js'
import { taskOps, configureTaskRuntimeAdapters } from '@slayzone/task/server'

const h = await createTestHarness()
setTaskDeps({ ops: taskOps })
const ctx = { db: h.slayDb, dataRoot: mkdtempSync(join(tmpdir(), 'trpc-template-')) }
configureTaskRuntimeAdapters({ getDataRoot: () => ctx.dataRoot })
const caller = templateRouter.createCaller(ctx)
const tasks = taskRouter.createCaller(ctx)

const COLUMNS = JSON.stringify([
  { id: 'todo', label: 'To Do', color: 'gray', position: 0, category: 'unstarted' },
  { id: 'in_progress', label: 'In Progress', color: 'blue', position: 1, category: 'started' },
  { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' }
])
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
  .run(projectId, 'P', '#000', '/tmp/p', COLUMNS)

const mkProject = (cols = COLUMNS): string => {
  const id = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'P-' + id.slice(0, 6), '#111', '/tmp/' + id.slice(0, 6), cols)
  return id
}
const createTemplate = (name: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>> =>
  caller.create({ projectId, name, ...extra } as unknown as CreateTaskTemplateInput) as Promise<Record<string, unknown>>
const PANEL = {
  terminal: true,
  browser: true,
  diff: false,
  settings: false,
  editor: false,
  artifacts: false,
  processes: false
}

test('template router: create defaults', async () => {
  const t = (await createTemplate('Basic')) as Record<string, unknown>
  expect(t.name).toBe('Basic')
  expect(t.project_id).toBe(projectId)
  expect(t.is_default).toBe(false)
  expect(t.terminal_mode).toBeNull()
  expect(t.provider_config).toBeNull()
  expect(t.panel_visibility).toBeNull()
  expect(t.browser_tabs).toBeNull()
  expect(t.web_panel_urls).toBeNull()
  expect(t.dangerously_skip_permissions).toBeNull()
  expect(t.default_status).toBeNull()
  expect(t.default_priority).toBeNull()
})

test('template router: create with all fields', async () => {
  const t = (await createTemplate('Full', {
    description: 'A full template',
    terminalMode: 'codex',
    providerConfig: { codex: { flags: '--sandbox workspace-write' } },
    panelVisibility: { ...PANEL, editor: false },
    browserTabs: { tabs: [{ id: 't1', url: 'http://localhost:3000', title: 'Dev' }], activeTabId: 't1' },
    webPanelUrls: { grafana: 'http://grafana.local' },
    dangerouslySkipPermissions: true,
    defaultStatus: 'todo',
    defaultPriority: 1
  })) as Record<string, any>
  expect(t.description).toBe('A full template')
  expect(t.terminal_mode).toBe('codex')
  expect(t.provider_config?.codex?.flags).toBe('--sandbox workspace-write')
  expect(t.panel_visibility?.terminal).toBe(true)
  expect(t.browser_tabs?.tabs).toHaveLength(1)
  expect(t.web_panel_urls?.grafana).toBe('http://grafana.local')
  expect(t.dangerously_skip_permissions).toBe(true)
  expect(t.default_status).toBe('todo')
  expect(t.default_priority).toBe(1)
})

test('template router: create as default + new default replaces previous', async () => {
  const pid = mkProject()
  const first = (await caller.create({ projectId: pid, name: 'First', isDefault: true } as never)) as Record<string, unknown>
  expect(first.is_default).toBe(true)
  await caller.create({ projectId: pid, name: 'Second', isDefault: true } as never)
  expect((await caller.get({ id: first.id as string }))?.is_default).toBe(false)
})

test('template router: getByProject returns + empty', async () => {
  const pid = mkProject()
  await caller.create({ projectId: pid, name: 'A' } as never)
  await caller.create({ projectId: pid, name: 'B' } as never)
  expect((await caller.getByProject({ projectId: pid })).length).toBe(2)
  expect((await caller.getByProject({ projectId: mkProject() })).length).toBe(0)
})

test('template router: get + update name + partial preserves + create→get→getByProject', async () => {
  const t = (await createTemplate('GetMe')) as Record<string, unknown>
  expect((await caller.get({ id: t.id as string }))?.name).toBe('GetMe')

  const partial = (await createTemplate('Partial', { terminalMode: 'codex', defaultPriority: 2 })) as Record<string, unknown>
  const updated = (await caller.update({ id: partial.id, defaultPriority: 5 } as never)) as Record<string, unknown>
  expect(updated.terminal_mode).toBe('codex')
  expect(updated.default_priority).toBe(5)
})

test('template router: update terminalMode + panelVisibility', async () => {
  const t = (await createTemplate('UpdateFields')) as Record<string, unknown>
  const updated = (await caller.update({ id: t.id, terminalMode: 'codex', panelVisibility: PANEL } as never)) as Record<string, any>
  expect(updated.terminal_mode).toBe('codex')
  expect(updated.panel_visibility?.browser).toBe(true)
})

test('template router: delete + setDefault set/clear', async () => {
  const t = (await createTemplate('ToDelete')) as Record<string, unknown>
  expect(await caller.delete({ id: t.id as string })).toBe(true)
  expect(await caller.get({ id: t.id as string })).toBeNull()

  const pid = mkProject()
  const setMe = (await caller.create({ projectId: pid, name: 'SetMe' } as never)) as Record<string, unknown>
  expect(setMe.is_default).toBe(false)
  await caller.setDefault({ projectId: pid, templateId: setMe.id as string })
  expect((await caller.get({ id: setMe.id as string }))?.is_default).toBe(true)
  await caller.setDefault({ projectId: pid, templateId: null })
  expect((await caller.get({ id: setMe.id as string }))?.is_default).toBe(false)
})

// Contract: templates do NOT throw on a missing id (unlike the task router) —
// get/update return null, delete returns false. Locks the cross-router asymmetry.
test('template router: missing id → null / false (no throw)', async () => {
  expect(await caller.get({ id: 'nope' })).toBeNull()
  expect(await caller.update({ id: 'nope', name: 'x' } as unknown as UpdateTaskTemplateInput)).toBeNull()
  expect(await caller.delete({ id: 'nope' })).toBe(false)
})

// ─── Template application at task creation (via taskRouter) ───

test('template application: explicit templateId applies all fields', async () => {
  const tmpl = (await createTemplate('ApplyAll', {
    terminalMode: 'codex',
    providerConfig: { codex: { flags: '--test-flag' } },
    panelVisibility: { ...PANEL, editor: true },
    browserTabs: { tabs: [{ id: 'b1', url: 'http://localhost', title: 'Local' }], activeTabId: 'b1' },
    webPanelUrls: { docs: 'http://docs.local' },
    dangerouslySkipPermissions: true,
    defaultStatus: 'todo',
    defaultPriority: 1
  })) as Record<string, unknown>
  const task = (await tasks.create({ projectId, title: 'FromTemplate', templateId: tmpl.id } as never)) as Record<string, any>
  expect(task.terminal_mode).toBe('codex')
  expect(task.provider_config.codex?.flags).toBe('--test-flag')
  expect(task.panel_visibility?.editor).toBe(true)
  expect(task.browser_tabs?.tabs).toHaveLength(1)
  expect(task.web_panel_urls?.docs).toBe('http://docs.local')
  expect(task.dangerously_skip_permissions).toBe(true)
  expect(task.status).toBe('todo')
  expect(task.priority).toBe(1)
})

test('template application: project default auto-applies when no templateId', async () => {
  const pid = mkProject(
    JSON.stringify([
      { id: 'backlog', label: 'Backlog', color: 'gray', position: 0, category: 'unstarted' },
      { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
    ])
  )
  await caller.create({ projectId: pid, name: 'ProjectDefault', isDefault: true, terminalMode: 'codex', defaultStatus: 'backlog', defaultPriority: 5 } as never)
  const task = (await tasks.create({ projectId: pid, title: 'Auto' } as never)) as Record<string, unknown>
  expect(task.terminal_mode).toBe('codex')
  expect(task.status).toBe('backlog')
  expect(task.priority).toBe(5)
})

test('template application: explicit input overrides template + no-template defaults + temp task', async () => {
  const tmpl = (await createTemplate('Overridable', { terminalMode: 'codex', defaultStatus: 'todo', defaultPriority: 1 })) as Record<string, unknown>
  const overridden = (await tasks.create({ projectId, title: 'Override', templateId: tmpl.id, terminalMode: 'claude-code', status: 'in_progress', priority: 4 } as never)) as Record<string, unknown>
  expect(overridden.terminal_mode).toBe('claude-code')
  expect(overridden.status).toBe('in_progress')
  expect(overridden.priority).toBe(4)

  const plainPid = mkProject()
  const plain = (await tasks.create({ projectId: plainPid, title: 'Plain' } as never)) as Record<string, unknown>
  expect(plain.terminal_mode).toBe('claude-code')
  expect(plain.priority).toBe(3)
  expect(plain.panel_visibility).toBeNull()
  expect(plain.browser_tabs).toBeNull()

  const tempTmpl = (await createTemplate('TempTemplate', { terminalMode: 'codex', defaultPriority: 2, panelVisibility: PANEL })) as Record<string, unknown>
  const temp = (await tasks.create({ projectId, title: 'Temp', isTemporary: true, templateId: tempTmpl.id } as never)) as Record<string, any>
  expect(temp.is_temporary).toBe(true)
  expect(temp.terminal_mode).toBe('codex')
  expect(temp.priority).toBe(2)
  expect(temp.panel_visibility?.browser).toBe(true)
})

// ─── updateTask persists template-like fields ───

test('updateTask: panelVisibility / browserTabs / webPanelUrls / terminalMode round-trip + combined', async () => {
  const t1 = (await tasks.create({ projectId, title: 'PanelRT' } as never)) as Record<string, unknown>
  const visUpdated = (await tasks.update({ id: t1.id, panelVisibility: { ...PANEL, editor: true } } as never)) as Record<string, any>
  expect(visUpdated.panel_visibility?.editor).toBe(true)
  expect(visUpdated.panel_visibility?.diff).toBe(false)

  const t2 = (await tasks.create({ projectId, title: 'BrowserRT' } as never)) as Record<string, unknown>
  const tabsUpdated = (await tasks.update({ id: t2.id, browserTabs: { tabs: [{ id: 'x', url: 'http://example.com', title: 'Ex' }], activeTabId: 'x' } } as never)) as Record<string, any>
  expect(tabsUpdated.browser_tabs?.tabs[0].url).toBe('http://example.com')
  expect(tabsUpdated.browser_tabs?.activeTabId).toBe('x')

  const t3 = (await tasks.create({ projectId, title: 'WebRT' } as never)) as Record<string, unknown>
  const webUpdated = (await tasks.update({ id: t3.id, webPanelUrls: { grafana: 'http://grafana.local', docs: 'http://docs.local' } } as never)) as Record<string, any>
  expect(webUpdated.web_panel_urls?.grafana).toBe('http://grafana.local')

  const t4 = (await tasks.create({ projectId, title: 'ModeChange' } as never)) as Record<string, unknown>
  expect(((await tasks.update({ id: t4.id, terminalMode: 'codex' } as never)) as Record<string, unknown>).terminal_mode).toBe('codex')

  const t5 = (await tasks.create({ projectId, title: 'ApplySimulation' } as never)) as Record<string, unknown>
  const combined = (await tasks.update({
    id: t5.id,
    terminalMode: 'codex',
    providerConfig: { codex: { flags: '--custom' } },
    panelVisibility: PANEL,
    browserTabs: { tabs: [{ id: 'b', url: 'http://app', title: 'App' }], activeTabId: 'b' },
    webPanelUrls: { panel1: 'http://panel.local' }
  } as never)) as Record<string, any>
  expect(combined.terminal_mode).toBe('codex')
  expect(combined.provider_config.codex?.flags).toBeTruthy()
  expect(combined.panel_visibility?.browser).toBe(true)
  expect(combined.browser_tabs?.tabs[0].url).toBe('http://app')
  expect(combined.web_panel_urls?.panel1).toBe('http://panel.local')
})
