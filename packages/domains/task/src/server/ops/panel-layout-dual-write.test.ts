/**
 * Panel layout dual-write (docs/plans/panel-model.md §1.2–1.4, v228): the hub keeps
 * `panel_layout` and the legacy `panel_visibility` / `panel_sizes` in sync, so older
 * apps, the CLI and REST see the same panels, and a template's layout reaches the
 * tasks made from it.
 *
 * Run with: ./node_modules/.bin/vitest run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/domains/task/src/server/ops/panel-layout-dual-write.test.ts
 */
import crypto from 'node:crypto'
import { expect, test } from 'vitest'
import {
  DEFAULT_PANEL_CONFIG,
  deriveLayoutFromLegacy,
  isInstanceVisible,
  resizeColumns,
  setSlotHidden,
  type TaskLayout
} from '@slayzone/task-contracts'
import { createTestHarness } from '../../../../../shared/test-utils/ipc-harness.js'
import { createTemplate, updateTemplate } from '../template-store.js'
import { createTaskOp } from './create.js'
import { updateTask } from './shared.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db
  .prepare('INSERT INTO projects (id, name, color, path, columns_config) VALUES (?, ?, ?, ?, ?)')
  .run(projectId, 'Proj', '#000', '/tmp/proj', JSON.stringify([]))

const rawRow = (id: string) =>
  h.db
    .prepare('SELECT panel_layout, panel_visibility, panel_sizes FROM tasks WHERE id = ?')
    .get(id) as {
    panel_layout: string | null
    panel_visibility: string | null
    panel_sizes: string | null
  }

/** Classic for the default config: agent + settings visible, browser hidden … */
const classic = (): TaskLayout => deriveLayoutFromLegacy({}, DEFAULT_PANEL_CONFIG)

test('a new task has no stored layout (derived on read)', async () => {
  const t = await createTaskOp(h.slayDb, { projectId, title: 'Fresh' }, {})
  expect(t?.panel_layout).toBeNull()
  expect(t?.panel_instance_state).toBeNull()
  expect(rawRow(t!.id).panel_layout).toBeNull()
})

test('writing panelLayout rewrites panel_visibility / panel_sizes from it', async () => {
  const t = await createTaskOp(h.slayDb, { projectId, title: 'Layout' }, {})
  // An older client's key the layout does not own survives the dual-write.
  await updateTask(h.slayDb, {
    id: t!.id,
    panelVisibility: { tests: true } as never,
    panelSizes: { 'web:old': { unit: 'px', value: 321 } }
  })
  let layout = setSlotHidden(classic(), 'browser', false)
  layout = setSlotHidden(layout, 'settings', true)
  layout = resizeColumns(layout, { browser: { unit: 'px', value: 640 } })

  const saved = await updateTask(h.slayDb, { id: t!.id, panelLayout: layout })
  expect(saved?.panel_layout?.columns.map((c) => c.id)).toEqual(layout.columns.map((c) => c.id))
  expect(saved?.panel_layout?.rev).toBe(layout.rev)
  expect(saved?.panel_visibility).toMatchObject({
    terminal: true,
    browser: true,
    settings: false,
    editor: false,
    tests: true
  })
  expect(saved?.panel_sizes).toEqual({
    browser: { unit: 'px', value: 640 },
    'web:old': { unit: 'px', value: 321 }
  })

  // null = back to derived; the legacy columns stay as they were.
  const cleared = await updateTask(h.slayDb, { id: t!.id, panelLayout: null })
  expect(cleared?.panel_layout).toBeNull()
  expect(cleared?.panel_visibility?.browser).toBe(true)
})

test('an invalid panelLayout is refused, nothing written', async () => {
  const t = await createTaskOp(h.slayDb, { projectId, title: 'Bad' }, {})
  await expect(
    updateTask(h.slayDb, { id: t!.id, panelLayout: { v: 2 } as unknown as TaskLayout })
  ).rejects.toThrow(/panelLayout/)
  expect(rawRow(t!.id).panel_layout).toBeNull()
})

test('a legacy-only write updates a stored panel_layout', async () => {
  const t = await createTaskOp(h.slayDb, { projectId, title: 'Legacy' }, {})
  const layout = classic()
  await updateTask(h.slayDb, { id: t!.id, panelLayout: layout })

  const shown = await updateTask(h.slayDb, {
    id: t!.id,
    panelVisibility: {
      terminal: true,
      browser: true,
      diff: false,
      settings: true,
      editor: false,
      artifacts: false,
      processes: false
    }
  })
  expect(shown?.panel_visibility?.browser).toBe(true)
  expect(isInstanceVisible(shown!.panel_layout!, 'browser')).toBe(true)
  expect(shown!.panel_layout!.rev).toBeGreaterThan(layout.rev)

  const sized = await updateTask(h.slayDb, {
    id: t!.id,
    panelSizes: { browser: { unit: 'px', value: 500 } }
  })
  expect(sized?.panel_sizes).toEqual({ browser: { unit: 'px', value: 500 } })
  expect(sized!.panel_layout!.columns.find((c) => c.id === 'browser')?.sizeOverride).toEqual({
    unit: 'px',
    value: 500
  })

  // A task with no stored layout keeps none: it is derived on read.
  const plain = await createTaskOp(h.slayDb, { projectId, title: 'Plain' }, {})
  const after = await updateTask(h.slayDb, {
    id: plain!.id,
    panelSizes: { browser: { unit: 'px', value: 500 } }
  })
  expect(after?.panel_layout).toBeNull()
})

test('panelInstanceState round-trips; null clears it', async () => {
  const t = await createTaskOp(h.slayDb, { projectId, title: 'State' }, {})
  const state = { 'editor:ab12cd34': { openFiles: ['a.ts'] } }
  expect(
    (await updateTask(h.slayDb, { id: t!.id, panelInstanceState: state }))?.panel_instance_state
  ).toEqual(state)
  expect(
    (await updateTask(h.slayDb, { id: t!.id, panelInstanceState: null }))?.panel_instance_state
  ).toBeNull()
})

test('a template keeps panel_layout and a task made from it copies it', async () => {
  const layout = resizeColumns(setSlotHidden(classic(), 'editor', false), {
    editor: { unit: 'px', value: 700 }
  })
  const tpl = await createTemplate(h.slayDb, {
    projectId,
    name: 'With layout',
    panelLayout: layout
  })
  expect(tpl?.panel_layout?.columns.map((c) => c.id)).toEqual(layout.columns.map((c) => c.id))
  // Dual-written: an older app reading the template sees the same panels.
  expect(tpl?.panel_visibility?.editor).toBe(true)

  const task = await createTaskOp(
    h.slayDb,
    { projectId, title: 'From tpl', templateId: tpl!.id },
    {}
  )
  expect(task?.panel_layout?.columns.map((c) => c.id)).toEqual(layout.columns.map((c) => c.id))
  expect(isInstanceVisible(task!.panel_layout!, 'editor')).toBe(true)
  expect(task?.panel_visibility?.editor).toBe(true)
  expect(task?.panel_sizes).toEqual({ editor: { unit: 'px', value: 700 } })

  // An older client's visibility-only template edit reaches the stored layout.
  const edited = await updateTemplate(h.slayDb, {
    id: tpl!.id,
    panelVisibility: { ...tpl!.panel_visibility!, editor: false }
  })
  expect(isInstanceVisible(edited!.panel_layout!, 'editor')).toBe(false)

  const cleared = await updateTemplate(h.slayDb, { id: tpl!.id, panelLayout: null })
  expect(cleared?.panel_layout).toBeNull()
  expect(cleared?.panel_visibility?.editor).toBe(false)
})

test("a new task starts from the creator's default layout; a template's wins over it", async () => {
  const focus: TaskLayout = {
    v: 1,
    rev: 7,
    layoutId: 'focus',
    columns: [
      {
        id: 'terminal',
        size: { unit: 'fr', value: 1 },
        slots: [
          {
            id: 'terminal',
            weight: 1,
            activeInstanceId: 'terminal',
            tabs: [{ instanceId: 'terminal' }]
          }
        ]
      }
    ],
    instances: { terminal: { id: 'terminal', kind: 'agent', settings: {} } }
  }
  const task = await createTaskOp(
    h.slayDb,
    { projectId, title: 'Default layout', defaultPanelLayout: focus },
    {}
  )
  expect(task?.panel_layout?.layoutId).toBe('focus')
  expect(task?.panel_layout?.rev).toBe(0)
  expect(task?.panel_visibility?.terminal).toBe(true)
  expect(task?.panel_visibility?.browser).toBeFalsy()

  const tpl = await createTemplate(h.slayDb, {
    projectId,
    name: 'Tpl layout',
    panelLayout: setSlotHidden(classic(), 'editor', false)
  })
  const fromTpl = await createTaskOp(
    h.slayDb,
    { projectId, title: 'Tpl wins', templateId: tpl!.id, defaultPanelLayout: focus },
    {}
  )
  expect(fromTpl?.panel_layout?.layoutId).toBe('classic')
  expect(isInstanceVisible(fromTpl!.panel_layout!, 'editor')).toBe(true)
})
