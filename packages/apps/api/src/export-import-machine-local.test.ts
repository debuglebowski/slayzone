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

test('§9 7d: an export carries no computer path of a task (worktree, custom folder)', async () => {
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
