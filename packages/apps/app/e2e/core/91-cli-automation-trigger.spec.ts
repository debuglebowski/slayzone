import { test, expect, seed, TEST_PROJECT_PATH, resetApp } from '../fixtures/electron'
import { spawnSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SLAY_JS = path.resolve(__dirname, '..', '..', '..', 'cli', 'dist', 'slay.js')

test.describe('CLI: automation triggers (end-to-end)', () => {
  let dbPath = ''
  let projectId = ''
  let mcpPort = 0

  test.beforeAll(async ({ electronApp, mainWindow }) => {
    await resetApp(mainWindow)
    if (!fs.existsSync(SLAY_JS)) {
      throw new Error(`CLI not built. Run: pnpm --filter @slayzone/cli build\nExpected: ${SLAY_JS}`)
    }

    const dbDir = await electronApp.evaluate(() => process.env.SLAYZONE_DB_DIR!)
    dbPath = path.join(dbDir, 'slayzone.dev.sqlite')

    mcpPort = await electronApp.evaluate(async () => {
      for (let i = 0; i < 20; i++) {
        const p = (globalThis as Record<string, unknown>).__mcpPort
        if (p) return p as number
        await new Promise((r) => setTimeout(r, 250))
      }
      return 0
    })
    expect(mcpPort).toBeTruthy()

    const s = seed(mainWindow)
    const p = await s.createProject({ name: 'Auto CLI', color: '#a855f7', path: TEST_PROJECT_PATH })
    projectId = p.id
    await s.refreshData()
  })

  const runCli = (...args: string[]) =>
    spawnSync('node', [SLAY_JS, ...args], {
      env: { ...process.env, SLAYZONE_DB_PATH: dbPath, SLAYZONE_MCP_PORT: String(mcpPort) },
      encoding: 'utf8',
    })

  const openDb = () => new DatabaseSync(dbPath)

  const insertAutomation = (opts: {
    name: string
    trigger: { type: string; params: Record<string, unknown> }
    actions: { type: string; params: Record<string, unknown> }[]
  }): string => {
    const id = crypto.randomUUID()
    const db = openDb()
    db.prepare(
      `INSERT INTO automations (id, project_id, name, enabled, trigger_config, conditions, actions, sort_order)
       VALUES (?, ?, ?, 1, ?, '[]', ?, 0)`
    ).run(id, projectId, opts.name, JSON.stringify(opts.trigger), JSON.stringify(opts.actions))
    db.close()
    return id
  }

  const waitForRun = async (
    automationId: string,
    timeoutMs = 10_000
  ): Promise<{ id: string; status: string; error: string | null; completed_at: string | null }> => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const db = openDb()
      const rows = db
        .prepare(
          `SELECT id, status, error, completed_at FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC`
        )
        .all(automationId) as { id: string; status: string; error: string | null; completed_at: string | null }[]
      db.close()
      if (rows.length > 0 && rows[0].status !== 'running') return rows[0]
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`Timed out waiting for automation run for ${automationId}`)
  }

  const cleanup = (opts: { automationId?: string; tmpFile?: string; taskTitle?: string; taskId?: string }) => {
    if (opts.tmpFile && fs.existsSync(opts.tmpFile)) fs.unlinkSync(opts.tmpFile)
    const db = openDb()
    if (opts.automationId) db.prepare('DELETE FROM automations WHERE id = ?').run(opts.automationId)
    if (opts.taskId) db.prepare('DELETE FROM tasks WHERE id = ?').run(opts.taskId)
    if (opts.taskTitle) db.prepare('DELETE FROM tasks WHERE title = ? AND project_id = ?').run(opts.taskTitle, projectId)
    db.close()
  }

  const tmpPath = (label: string) => path.join(os.tmpdir(), `auto-${label}-${crypto.randomUUID()}.txt`)

  test('task_archived: slay tasks archive fires automation', async ({ mainWindow }) => {
    const tmpFile = tmpPath('archive')
    const automationId = insertAutomation({
      name: 'archive auto',
      trigger: { type: 'task_archived', params: {} },
      actions: [{ type: 'run_command', params: { command: `echo fired > ${tmpFile}` } }],
    })

    const s = seed(mainWindow)
    const task = await s.createTask({ projectId, title: 'auto-archive-target', status: 'todo' })
    await s.refreshData()

    const r = runCli('tasks', 'archive', task.id)
    expect(r.status, r.stderr).toBe(0)

    const run = await waitForRun(automationId)
    expect(run.status).toBe('success')
    expect(run.error).toBeNull()
    expect(run.completed_at).toBeTruthy()

    expect(fs.existsSync(tmpFile)).toBe(true)
    expect(fs.readFileSync(tmpFile, 'utf8').trim()).toBe('fired')

    cleanup({ automationId, tmpFile, taskId: task.id })
  })

  test('task_created: slay tasks create fires automation', async () => {
    const tmpFile = tmpPath('create')
    const automationId = insertAutomation({
      name: 'create auto',
      trigger: { type: 'task_created', params: {} },
      actions: [{ type: 'run_command', params: { command: `echo fired > ${tmpFile}` } }],
    })

    const title = `auto-create-${Date.now()}`
    const r = runCli('tasks', 'create', title, '--project', 'auto cli')
    expect(r.status, r.stderr).toBe(0)

    const run = await waitForRun(automationId)
    expect(run.status).toBe('success')
    expect(run.error).toBeNull()
    expect(run.completed_at).toBeTruthy()

    expect(fs.existsSync(tmpFile)).toBe(true)
    expect(fs.readFileSync(tmpFile, 'utf8').trim()).toBe('fired')

    cleanup({ automationId, tmpFile, taskTitle: title })
  })

  test('task_status_change: slay tasks done fires automation', async ({ mainWindow }) => {
    const tmpFile = tmpPath('status')
    const automationId = insertAutomation({
      name: 'status auto',
      trigger: { type: 'task_status_change', params: { fromStatus: 'todo', toStatus: 'done' } },
      actions: [{ type: 'run_command', params: { command: `echo fired > ${tmpFile}` } }],
    })

    const s = seed(mainWindow)
    const task = await s.createTask({ projectId, title: 'auto-status-target', status: 'todo' })
    await s.refreshData()

    const r = runCli('tasks', 'done', task.id)
    expect(r.status, r.stderr).toBe(0)

    const run = await waitForRun(automationId)
    expect(run.status).toBe('success')
    expect(run.error).toBeNull()
    expect(run.completed_at).toBeTruthy()

    expect(fs.existsSync(tmpFile)).toBe(true)
    expect(fs.readFileSync(tmpFile, 'utf8').trim()).toBe('fired')

    cleanup({ automationId, tmpFile, taskId: task.id })
  })
})
