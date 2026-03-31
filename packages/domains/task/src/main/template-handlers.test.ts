/**
 * Template handler contract tests
 * Run with: ELECTRON_RUN_AS_NODE=1 pnpm electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/task/src/main/template-handlers.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerTaskHandlers } from './handlers.js'
import { registerTaskTemplateHandlers } from './template-handlers.js'
import type { Task } from '../shared/types.js'
import type { TaskTemplate } from '../shared/templates.js'

const h = await createTestHarness()
registerTaskHandlers(h.ipcMain as never, h.db)
registerTaskTemplateHandlers(h.ipcMain as never, h.db)

// Seed project
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
  projectId, 'TemplateProject', '#000', '/tmp/template-test',
  JSON.stringify([
    { id: 'todo', label: 'To Do', color: 'gray', position: 0, category: 'unstarted' },
    { id: 'in_progress', label: 'In Progress', color: 'blue', position: 1, category: 'started' },
    { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' },
  ])
)

// Async helpers (task handlers are async)
async function createTask(title: string, extra?: Record<string, unknown>): Promise<Task> {
  return await h.invoke('db:tasks:create', { projectId, title, ...extra }) as Task
}

function createTemplate(name: string, extra?: Record<string, unknown>): TaskTemplate {
  return h.invoke('db:taskTemplates:create', { projectId, name, ...extra }) as TaskTemplate
}

// ─── Template CRUD ───

await describe('db:taskTemplates:create', () => {
  test('creates with defaults', () => {
    const t = createTemplate('Basic')
    expect(t.name).toBe('Basic')
    expect(t.project_id).toBe(projectId)
    expect(t.is_default).toBe(false)
    expect(t.terminal_mode).toBeNull()
    expect(t.provider_config).toBeNull()
    expect(t.panel_visibility).toBeNull()
    expect(t.browser_tabs).toBeNull()
    expect(t.web_panel_urls).toBeNull()
    expect(t.dangerously_skip_permissions).toBeNull()
    expect(t.ccs_profile).toBeNull()
    expect(t.default_status).toBeNull()
    expect(t.default_priority).toBeNull()
  })

  test('creates with all fields', () => {
    const t = createTemplate('Full', {
      description: 'A full template',
      terminalMode: 'codex',
      providerConfig: { codex: { flags: '--full-auto' } },
      panelVisibility: { terminal: true, browser: true, diff: false, settings: false, editor: false, processes: false },
      browserTabs: { tabs: [{ id: 't1', url: 'http://localhost:3000', title: 'Dev' }], activeTabId: 't1' },
      webPanelUrls: { grafana: 'http://grafana.local' },
      dangerouslySkipPermissions: true,
      ccsProfile: 'fast',
      defaultStatus: 'todo',
      defaultPriority: 1,
    })
    expect(t.description).toBe('A full template')
    expect(t.terminal_mode).toBe('codex')
    expect(t.provider_config?.codex?.flags).toBe('--full-auto')
    expect(t.panel_visibility?.terminal).toBe(true)
    expect(t.panel_visibility?.browser).toBe(true)
    expect(t.browser_tabs?.tabs).toHaveLength(1)
    expect(t.browser_tabs?.activeTabId).toBe('t1')
    expect(t.web_panel_urls?.grafana).toBe('http://grafana.local')
    expect(t.dangerously_skip_permissions).toBe(true)
    expect(t.ccs_profile).toBe('fast')
    expect(t.default_status).toBe('todo')
    expect(t.default_priority).toBe(1)
  })

  test('creates as default', () => {
    const pid = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(pid, 'DefProj', '#111', '/tmp/def')
    const t = h.invoke('db:taskTemplates:create', { projectId: pid, name: 'Default', isDefault: true }) as TaskTemplate
    expect(t.is_default).toBe(true)
  })

  test('new default replaces previous default', () => {
    const pid = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(pid, 'ReplProj', '#222', '/tmp/repl')
    const first = h.invoke('db:taskTemplates:create', { projectId: pid, name: 'First', isDefault: true }) as TaskTemplate
    h.invoke('db:taskTemplates:create', { projectId: pid, name: 'Second', isDefault: true })
    const firstReloaded = h.invoke('db:taskTemplates:get', first.id) as TaskTemplate
    expect(firstReloaded.is_default).toBe(false)
  })
})

await describe('db:taskTemplates:getByProject', () => {
  test('returns templates for project', () => {
    const pid = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(pid, 'ListProj', '#333', '/tmp/list')
    h.invoke('db:taskTemplates:create', { projectId: pid, name: 'A' })
    h.invoke('db:taskTemplates:create', { projectId: pid, name: 'B' })
    const templates = h.invoke('db:taskTemplates:getByProject', pid) as TaskTemplate[]
    expect(templates).toHaveLength(2)
  })

  test('returns empty for project with no templates', () => {
    const pid = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(pid, 'EmptyProj', '#444', '/tmp/empty')
    const templates = h.invoke('db:taskTemplates:getByProject', pid) as TaskTemplate[]
    expect(templates).toHaveLength(0)
  })
})

await describe('db:taskTemplates:get', () => {
  test('returns template by id', () => {
    const t = createTemplate('GetMe')
    const fetched = h.invoke('db:taskTemplates:get', t.id) as TaskTemplate
    expect(fetched.name).toBe('GetMe')
  })

  test('returns null for nonexistent', () => {
    expect(h.invoke('db:taskTemplates:get', 'nope')).toBeNull()
  })
})

await describe('db:taskTemplates:update', () => {
  test('updates name', () => {
    const t = createTemplate('OldName')
    const updated = h.invoke('db:taskTemplates:update', { id: t.id, name: 'NewName' }) as TaskTemplate
    expect(updated.name).toBe('NewName')
  })

  test('updates terminal_mode and panel_visibility', () => {
    const t = createTemplate('UpdateFields')
    const updated = h.invoke('db:taskTemplates:update', {
      id: t.id,
      terminalMode: 'codex',
      panelVisibility: { terminal: true, browser: true, diff: false, settings: false, editor: false, processes: false },
    }) as TaskTemplate
    expect(updated.terminal_mode).toBe('codex')
    expect(updated.panel_visibility?.browser).toBe(true)
  })

  test('partial update preserves other fields', () => {
    const t = createTemplate('Partial', { terminalMode: 'codex', defaultPriority: 2 })
    const updated = h.invoke('db:taskTemplates:update', { id: t.id, defaultPriority: 5 }) as TaskTemplate
    expect(updated.terminal_mode).toBe('codex')
    expect(updated.default_priority).toBe(5)
  })

  test('returns null for nonexistent', () => {
    expect(h.invoke('db:taskTemplates:update', { id: 'nope', name: 'X' })).toBeNull()
  })
})

await describe('db:taskTemplates:delete', () => {
  test('deletes template', () => {
    const t = createTemplate('ToDelete')
    expect(h.invoke('db:taskTemplates:delete', t.id)).toBe(true)
    expect(h.invoke('db:taskTemplates:get', t.id)).toBeNull()
  })

  test('returns false for nonexistent', () => {
    expect(h.invoke('db:taskTemplates:delete', 'nope')).toBe(false)
  })
})

await describe('db:taskTemplates:setDefault', () => {
  test('sets default', () => {
    const pid = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(pid, 'SetDef', '#555', '/tmp/setdef')
    const t = h.invoke('db:taskTemplates:create', { projectId: pid, name: 'SetMe' }) as TaskTemplate
    expect(t.is_default).toBe(false)
    h.invoke('db:taskTemplates:setDefault', pid, t.id)
    const reloaded = h.invoke('db:taskTemplates:get', t.id) as TaskTemplate
    expect(reloaded.is_default).toBe(true)
  })

  test('clears default with null', () => {
    const pid = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(pid, 'ClrDef', '#666', '/tmp/clrdef')
    const t = h.invoke('db:taskTemplates:create', { projectId: pid, name: 'ClearMe', isDefault: true }) as TaskTemplate
    h.invoke('db:taskTemplates:setDefault', pid, null)
    const reloaded = h.invoke('db:taskTemplates:get', t.id) as TaskTemplate
    expect(reloaded.is_default).toBe(false)
  })
})

// ─── Template application at task creation (async — handlers return Promise) ───

await describe('template application on task creation', () => {
  test('explicit templateId applies all template fields', async () => {
    const tmpl = createTemplate('ApplyAll', {
      terminalMode: 'codex',
      providerConfig: { codex: { flags: '--test-flag' } },
      panelVisibility: { terminal: true, browser: true, diff: false, settings: false, editor: true, processes: false },
      browserTabs: { tabs: [{ id: 'b1', url: 'http://localhost', title: 'Local' }], activeTabId: 'b1' },
      webPanelUrls: { docs: 'http://docs.local' },
      dangerouslySkipPermissions: true,
      ccsProfile: 'turbo',
      defaultStatus: 'todo',
      defaultPriority: 1,
    })
    const task = await createTask('FromTemplate', { templateId: tmpl.id })
    expect(task.terminal_mode).toBe('codex')
    expect(task.provider_config.codex?.flags).toBe('--test-flag')
    expect(task.panel_visibility?.terminal).toBe(true)
    expect(task.panel_visibility?.browser).toBe(true)
    expect(task.panel_visibility?.editor).toBe(true)
    expect(task.browser_tabs?.tabs).toHaveLength(1)
    expect(task.web_panel_urls?.docs).toBe('http://docs.local')
    expect(task.dangerously_skip_permissions).toBe(true)
    expect(task.ccs_profile).toBe('turbo')
    expect(task.status).toBe('todo')
    expect(task.priority).toBe(1)
  })

  test('project default template auto-applies when no templateId', async () => {
    const pid = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)').run(
      pid, 'AutoDefault', '#777', '/tmp/autodef',
      JSON.stringify([
        { id: 'backlog', label: 'Backlog', color: 'gray', position: 0, category: 'unstarted' },
        { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' },
      ])
    )
    h.invoke('db:taskTemplates:create', {
      projectId: pid, name: 'ProjectDefault', isDefault: true,
      terminalMode: 'codex', defaultStatus: 'backlog', defaultPriority: 5,
    })
    const task = await h.invoke('db:tasks:create', { projectId: pid, title: 'Auto' }) as Task
    expect(task.terminal_mode).toBe('codex')
    expect(task.status).toBe('backlog')
    expect(task.priority).toBe(5)
  })

  test('explicit input overrides template values', async () => {
    const tmpl = createTemplate('Overridable', {
      terminalMode: 'codex', defaultStatus: 'todo', defaultPriority: 1,
    })
    const task = await createTask('Override', {
      templateId: tmpl.id,
      terminalMode: 'claude-code',
      status: 'in_progress',
      priority: 4,
    })
    expect(task.terminal_mode).toBe('claude-code')
    expect(task.status).toBe('in_progress')
    expect(task.priority).toBe(4)
  })

  test('no template uses defaults', async () => {
    const pid = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(pid, 'NoTmpl', '#888', '/tmp/notmpl')
    const task = await h.invoke('db:tasks:create', { projectId: pid, title: 'Plain' }) as Task
    expect(task.terminal_mode).toBe('claude-code')
    expect(task.priority).toBe(3)
    expect(task.panel_visibility).toBeNull()
    expect(task.browser_tabs).toBeNull()
  })

  test('temporary task with templateId gets template applied', async () => {
    const tmpl = createTemplate('TempTemplate', {
      terminalMode: 'codex', defaultPriority: 2,
      panelVisibility: { terminal: true, browser: true, diff: false, settings: false, editor: false, processes: false },
    })
    const task = await createTask('Temp', { isTemporary: true, templateId: tmpl.id })
    expect(task.is_temporary).toBe(true)
    expect(task.terminal_mode).toBe('codex')
    expect(task.priority).toBe(2)
    expect(task.panel_visibility?.browser).toBe(true)
  })
})

// ─── updateTask with template-like fields (what applyTemplate sends) ───

await describe('updateTask persists template-like fields', () => {
  test('panelVisibility round-trips', async () => {
    const task = await createTask('PanelRT')
    const vis = { terminal: true, browser: true, diff: false, settings: false, editor: true, processes: false }
    const updated = h.invoke('db:tasks:update', { id: task.id, panelVisibility: vis }) as Task
    expect(updated.panel_visibility?.terminal).toBe(true)
    expect(updated.panel_visibility?.browser).toBe(true)
    expect(updated.panel_visibility?.editor).toBe(true)
    expect(updated.panel_visibility?.diff).toBe(false)
  })

  test('browserTabs round-trips', async () => {
    const task = await createTask('BrowserRT')
    const tabs = { tabs: [{ id: 'x', url: 'http://example.com', title: 'Ex' }], activeTabId: 'x' }
    const updated = h.invoke('db:tasks:update', { id: task.id, browserTabs: tabs }) as Task
    expect(updated.browser_tabs?.tabs).toHaveLength(1)
    expect(updated.browser_tabs?.tabs[0].url).toBe('http://example.com')
    expect(updated.browser_tabs?.activeTabId).toBe('x')
  })

  test('webPanelUrls round-trips', async () => {
    const task = await createTask('WebRT')
    const urls = { grafana: 'http://grafana.local', docs: 'http://docs.local' }
    const updated = h.invoke('db:tasks:update', { id: task.id, webPanelUrls: urls }) as Task
    expect(updated.web_panel_urls?.grafana).toBe('http://grafana.local')
    expect(updated.web_panel_urls?.docs).toBe('http://docs.local')
  })

  test('terminalMode change persists', async () => {
    const task = await createTask('ModeChange')
    expect(task.terminal_mode).toBe('claude-code')
    const updated = h.invoke('db:tasks:update', { id: task.id, terminalMode: 'codex' }) as Task
    expect(updated.terminal_mode).toBe('codex')
  })

  test('combined update (simulates applyTemplate call)', async () => {
    const task = await createTask('ApplySimulation')
    const updated = h.invoke('db:tasks:update', {
      id: task.id,
      terminalMode: 'codex',
      providerConfig: { codex: { flags: '--custom' } },
      panelVisibility: { terminal: true, browser: true, diff: false, settings: false, editor: false, processes: false },
      browserTabs: { tabs: [{ id: 'b', url: 'http://app', title: 'App' }], activeTabId: 'b' },
      webPanelUrls: { panel1: 'http://panel.local' },
    }) as Task
    expect(updated.terminal_mode).toBe('codex')
    // terminalMode change seeds default flags on top of providerConfig merge
    expect(updated.provider_config.codex?.flags).toBeTruthy()
    expect(updated.panel_visibility?.browser).toBe(true)
    expect(updated.browser_tabs?.tabs[0].url).toBe('http://app')
    expect(updated.web_panel_urls?.panel1).toBe('http://panel.local')
  })
})

h.cleanup()
console.log('\nDone')
