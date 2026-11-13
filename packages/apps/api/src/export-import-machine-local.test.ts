/**
 * Final review round 3, R3-2: `local_computer_work_roots` records which allowed
 * roots the hub added to its own machine's local computer (for worktree bases and
 * automation folders), so it can remove them again. The local computer's id is the
 * same on every machine (a hash of a constant), so an export imported elsewhere would
 * make that machine remove a root its user added by hand at the same path. The key
 * describes one machine: it is never exported, and an import ignores it.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TypedEmitter } from '@slayzone/platform/events'
import { afterAll, expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { createAccessScope } from './access'
import { getAppDeps, setAppDeps, setNotifyEvents, type NotifyEventMap } from './app-deps'
import { buildExportImportOps } from './export-import'
import { getTaskPathsDelegate, setTaskPathsDelegate } from '@slayzone/task/server'

const h = await createTestHarness()
const dir = mkdtempSync(join(tmpdir(), 'export-machine-local-'))
setNotifyEvents(new TypedEmitter<NotifyEventMap>())
let deps: ReturnType<typeof getAppDeps> | null = null
try {
  deps = getAppDeps()
} catch {
  deps = null
}
setAppDeps({ ...(deps ?? {}), appGetVersion: async () => '0.0.0-test' } as never)

const KEY = 'local_computer_work_roots'
const ops = buildExportImportOps(
  h.slayDb,
  { userId: null, scope: createAccessScope(h.slayDb, { authRequired: false, principal: null }) },
  true
)
const value = (key: string): string | undefined =>
  (
    h.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
  )?.value

test('R3-2: the whole-hub export leaves the machine-local key out', async () => {
  h.db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(KEY, JSON.stringify({ 'local-computer': ['/opt/tools'] }))
  h.db
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('worktree_base_path', '/Volumes/wt')
  const file = join(dir, 'all.slay')
  expect((await ops.testExportAllToPath!(file)).success).toBe(true)
  const keys = (
    JSON.parse(readFileSync(file, 'utf8')) as { data: { settings: { key: string }[] } }
  ).data.settings.map((s) => s.key)
  expect(keys).toContain('worktree_base_path')
  expect(keys).not.toContain(KEY)
})

test('R3-2: an import ignores the machine-local key from an older bundle', async () => {
  h.db.prepare('DELETE FROM settings WHERE key = ?').run(KEY)
  const file = join(dir, 'old.slay')
  writeFileSync(
    file,
    JSON.stringify({
      meta: { version: 1, scope: 'all' },
      data: {
        projects: [],
        tasks: [],
        tags: [],
        task_tags: [],
        task_dependencies: [],
        terminal_tabs: [],
        ai_config_items: [],
        ai_config_project_selections: [],
        ai_config_sources: [],
        settings: [
          { key: KEY, value: JSON.stringify({ 'local-computer': ['/Users/me/mine'] }) },
          { key: 'r32_other_setting', value: 'kept' }
        ]
      }
    })
  )
  const result = await ops.testImportFromPath!(file)
  expect(result.success, String(result.error)).toBe(true)
  expect(value(KEY)).toBeUndefined()
  expect(value('r32_other_setting')).toBe('kept')
})

// S3: a task's custom folder (base_dir) survived an export → import before §9 7d; it
// lives on the task's computer now, so the export reads it there and the import hands
// it to the importer's computer (staged when none is connected). The worktree never
// travelled (it is a checkout of this machine) and still does not.
test('S3: a custom folder round-trips export → import through the computers', async () => {
  const projectId = crypto.randomUUID()
  const taskId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)')
    .run(projectId, 'PS3', '#000')
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, has_worktree, has_base_dir) VALUES (?, ?, ?, 1, 1)'
    )
    .run(taskId, projectId, 'Custom folder task')
  const changed: Array<{ taskId: string; change: unknown }> = []
  const previous = getTaskPathsDelegate()
  setTaskPathsDelegate({
    read: async (ids) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          id === taskId
            ? { state: 'ok', worktreePath: '/wt/s3', baseDir: '/Users/me/custom' }
            : { state: 'ok', worktreePath: null, baseDir: null }
        ])
      ),
    changed: async (id, change) => {
      changed.push({ taskId: id, change })
    },
    release: async () => {
      throw new Error('unused')
    },
    apply: async (_taskId, patch) => patch,
    forget: async () => undefined
  })
  try {
    const file = join(dir, 's3.slay')
    expect((await ops.testExportAllToPath!(file)).success).toBe(true)
    const exported = (
      JSON.parse(readFileSync(file, 'utf8')) as { data: { tasks: Record<string, unknown>[] } }
    ).data.tasks.find((t) => t.id === taskId)
    expect(exported).toMatchObject({ base_dir: '/Users/me/custom' })
    expect(exported).not.toHaveProperty('worktree_path')

    {
      changed.length = 0
      const result = await ops.testImportFromPath!(file)
      expect(result.success, String(result.error)).toBe(true)
      const imported = h.db
        .prepare(
          "SELECT id, has_base_dir, has_worktree FROM tasks WHERE title = 'Custom folder task' AND id != ?"
        )
        .all(taskId) as Array<{ id: string; has_base_dir: number; has_worktree: number }>
      const fresh = imported.at(-1)!
      expect(fresh).toMatchObject({ has_base_dir: 1, has_worktree: 0 })
      expect(changed).toContainEqual({
        taskId: fresh.id,
        change: { op: 'set', baseDir: '/Users/me/custom' }
      })
    }
  } finally {
    setTaskPathsDelegate(previous)
  }
})

test('S3: an older bundle naming base_dir as a column restores it on import', async () => {
  const changed: Array<{ taskId: string; change: unknown }> = []
  const previous = getTaskPathsDelegate()
  setTaskPathsDelegate({
    read: async () => ({}),
    changed: async (id, change) => {
      changed.push({ taskId: id, change })
    },
    release: async () => {
      throw new Error('unused')
    },
    apply: async (_taskId, patch) => patch,
    forget: async () => undefined
  })
  try {
    const file = join(dir, 'old-base-dir.slay')
    const oldProject = crypto.randomUUID()
    writeFileSync(
      file,
      JSON.stringify({
        meta: { version: 1, scope: 'all' },
        data: {
          projects: [{ id: oldProject, name: 'Old S3', color: '#000' }],
          tasks: [
            {
              id: crypto.randomUUID(),
              project_id: oldProject,
              title: 'Old custom folder task',
              provider_config: '{}',
              base_dir: '/Users/me/old-custom',
              worktree_path: '/wt/old'
            }
          ],
          tags: [],
          task_tags: [],
          task_dependencies: [],
          terminal_tabs: [],
          ai_config_items: [],
          ai_config_project_selections: [],
          ai_config_sources: [],
          settings: []
        }
      })
    )
    const result = await ops.testImportFromPath!(file)
    expect(result.success, String(result.error)).toBe(true)
    const row = h.db
      .prepare(
        "SELECT id, has_base_dir, has_worktree FROM tasks WHERE title = 'Old custom folder task'"
      )
      .get() as { id: string; has_base_dir: number; has_worktree: number }
    expect(row).toMatchObject({ has_base_dir: 1, has_worktree: 0 })
    expect(changed).toEqual([
      { taskId: row.id, change: { op: 'set', baseDir: '/Users/me/old-custom' } }
    ])
  } finally {
    setTaskPathsDelegate(previous)
  }
})

test('§9 7d: an export carries no worktree, and no custom folder its computer cannot answer for', async () => {
  const projectId = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)')
    .run(projectId, 'P7d', '#000')
  h.db
    .prepare(
      'INSERT INTO tasks (id, project_id, title, has_worktree, has_base_dir) VALUES (?, ?, ?, 1, 1)'
    )
    .run(crypto.randomUUID(), projectId, 'T')
  const file = join(dir, 'paths.slay')
  expect((await ops.testExportAllToPath!(file)).success).toBe(true)
  const text = readFileSync(file, 'utf8')
  const tasks = (JSON.parse(text) as { data: { tasks: Record<string, unknown>[] } }).data.tasks
  expect(tasks.length).toBeGreaterThan(0)
  for (const t of tasks) {
    expect(t).not.toHaveProperty('worktree_path')
    expect(t).not.toHaveProperty('base_dir')
  }
})

afterAll(() => h.cleanup())
