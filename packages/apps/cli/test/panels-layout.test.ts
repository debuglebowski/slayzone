/**
 * `slay panels layout …` (docs/plans/panel-model.md step 13): placement parsing and
 * the text output as units, then the bundled CLI against an in-process REST stack —
 * show / open / hide / close / apply, task-id auto-resolution from
 * $SLAYZONE_TASK_ID, and the agent gate (a task terminal's `slay` is an agent).
 *
 * Run with: ./node_modules/.bin/vitest run --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/cli/test/panels-layout.test.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import express from 'express'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, test } from 'vitest'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../shared/test-utils/rest-harness.js'
import { DB_PRAGMAS } from '../../../shared/platform/src/index.js'
import { registerRestApi } from '../../../apps/api/src/http/rest-api/index.js'
import { formatLayout, parsePlacement } from '../src/commands/panels.js'
import { deriveLayoutFromLegacy, DEFAULT_PANEL_CONFIG } from '@slayzone/task-contracts'

describe('parsePlacement', () => {
  test.each([
    ['column', { type: 'column' }],
    ['column:2', { type: 'column', index: 2 }],
    ['tab:terminal', { type: 'tab', slotId: 'terminal' }],
    ['tab:browser:1a2b3c4d', { type: 'tab', slotId: 'browser:1a2b3c4d' }],
    ['tab:browser:1a2b3c4d:0', { type: 'tab', slotId: 'browser:1a2b3c4d', index: 0 }],
    ['split:editor:right', { type: 'split', slotId: 'editor', zone: 'right' }],
    ['split:git:9f8e7d6c:after', { type: 'split', slotId: 'git:9f8e7d6c', zone: 'after' }],
    ['{"type":"column","index":1}', { type: 'column', index: 1 }]
  ])('%s', (raw, want) => {
    expect(parsePlacement(raw)).toEqual(want)
  })

  test.each(['row', 'tab:', 'split:editor:up', 'column:x'])('%s is refused', (raw) => {
    expect(() => parsePlacement(raw)).toThrow()
  })
})

test('formatLayout lists columns, groups and panel ids', () => {
  const text = formatLayout({
    taskId: 't',
    layout: deriveLayoutFromLegacy({}, DEFAULT_PANEL_CONFIG),
    definitions: [
      { id: 'classic', name: 'Classic', builtin: true, enabled: true },
      { id: 'focus', name: 'Focus', builtin: true, enabled: false }
    ],
    agentMayChangeLayout: false
  })
  expect(text).toMatch(/^Layout: classic \(rev 0\)/)
  expect(text).toMatch(/ {4}terminal +agent +\(active\)/)
  expect(text).toMatch(/Group browser {2}hidden/)
  expect(text).toContain('Layouts: classic*, focus (off)')
  expect(text).toContain('Agents may change the layout: no')
})

const SLAY_BIN = path.resolve(import.meta.dirname, '../dist/slay.js')
const HAS_SLAY_BIN = fs.existsSync(SLAY_BIN)
if (!HAS_SLAY_BIN)
  console.error('SKIP: dist/slay.js not built. Run `pnpm --filter @slayzone/cli build` first.')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slay-cli-layout-'))
const storageDir = path.join(tmpDir, 'storage')
fs.mkdirSync(storageDir, { recursive: true })
const db = new Database(path.join(storageDir, 'slayzone.dev.data.sqlite'))
for (const pragma of DB_PRAGMAS) db.pragma(pragma)
const mod = await import(
  path.resolve(import.meta.dirname, '../../../shared/db-migrations/src/migrations.ts')
)
mod.runMigrations(db)

const projectId = crypto.randomUUID()
db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
  projectId,
  'LAYOUT',
  '#000',
  tmpDir
)
const taskId = crypto.randomUUID()
db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)').run(
  taskId,
  projectId,
  'Layout task'
)

const app = express()
app.use(express.json())
registerRestApi(app, { db: createSlayzoneDbAdapter(db), notifyRenderer: () => {} })
const rest = await mountRestApp(app)

function runCli(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn('node', [SLAY_BIN, ...args], {
      env: {
        ...(process.env as Record<string, string>),
        SLAYZONE_ROOT: tmpDir,
        SLAYZONE_DEV: '1',
        SLAYZONE_HUB_ADDRESS: `127.0.0.1:${rest.port}`,
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (d) => (stdout += d.toString()))
    p.stderr.on('data', (d) => (stderr += d.toString()))
    p.on('close', (code) => resolve({ exitCode: code, stdout, stderr }))
  })
}

const storedLayout = () =>
  JSON.parse(
    (
      db.prepare('SELECT panel_layout FROM tasks WHERE id = ?').get(taskId) as {
        panel_layout: string
      }
    ).panel_layout
  ) as { layoutId: string; instances: Record<string, { kind: string; name?: string }> }

describe.skipIf(!HAS_SLAY_BIN)('slay panels layout → REST', () => {
  test('show prints the layout of -t <id prefix>', async () => {
    const r = await runCli(['panels', 'layout', 'show', '-t', taskId.slice(0, 8)])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/^Layout: classic/)
    expect(r.stdout).toContain('Agents may change the layout: yes')
  })

  test('open, hide and close a panel', async () => {
    const opened = await runCli([
      'panels',
      'layout',
      'open',
      'web',
      '-t',
      taskId,
      '--settings',
      '{"url":"example.com"}',
      '--placement',
      'tab:terminal',
      '--name',
      'Docs',
      '--json'
    ])
    expect(opened.exitCode).toBe(0)
    const id = (JSON.parse(opened.stdout) as { instanceId: string }).instanceId
    expect(storedLayout().instances[id]).toMatchObject({ kind: 'web', name: 'Docs' })

    const hidden = await runCli(['panels', 'layout', 'hide', id, '-t', taskId])
    expect(hidden.stdout.trim()).toBe(`Hid panel ${id}`)

    const closed = await runCli(['panels', 'layout', 'close', id, '-t', taskId])
    expect(closed.stdout.trim()).toBe(`Closed panel ${id}`)
    expect(storedLayout().instances[id]).toBeUndefined()

    const primary = await runCli(['panels', 'layout', 'close', 'browser', '-t', taskId])
    expect(primary.stdout.trim()).toBe('Hid panel browser')
  })

  test('apply switches layouts; an unknown one fails with the list', async () => {
    const r = await runCli(['panels', 'layout', 'apply', 'Focus', '-t', taskId])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('Applied layout focus')
    expect(storedLayout().layoutId).toBe('focus')

    const bad = await runCli(['panels', 'layout', 'apply', 'nope', '-t', taskId])
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toMatch(/Unknown layout "nope"/)
  })

  test('apply <file.json> takes `show --json` output', async () => {
    const shown = await runCli(['panels', 'layout', 'show', '-t', taskId, '--json'])
    const file = path.join(tmpDir, 'layout.json')
    const view = JSON.parse(shown.stdout) as { layout: { layoutId: string } }
    view.layout.layoutId = 'from-file'
    fs.writeFileSync(file, JSON.stringify(view))
    const r = await runCli(['panels', 'layout', 'apply', file, '-t', taskId])
    expect(r.exitCode).toBe(0)
    expect(storedLayout().layoutId).toBe('from-file')
  })

  test('a task terminal targets its own task and is refused while agents may not change the layout', async () => {
    const terminal = { SLAYZONE_TASK_ID: taskId }
    const ok = await runCli(['panels', 'layout', 'open', 'processes'], terminal)
    expect(ok.exitCode).toBe(0)
    expect(ok.stdout).toMatch(/^(Opened|Showed) panel processes/)

    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
      'agent_may_change_layout',
      '0'
    )
    const refused = await runCli(['panels', 'layout', 'hide', 'processes'], terminal)
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toMatch(/does not let agents change the task layout/)
    // The user's own shell (no task terminal) still may.
    const mine = await runCli(['panels', 'layout', 'hide', 'processes', '-t', taskId])
    expect(mine.exitCode).toBe(0)
    db.prepare('DELETE FROM settings WHERE key = ?').run('agent_may_change_layout')
  })
})

afterAll(async () => {
  await rest.close()
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
