/**
 * Session retention (T-23) through the REAL built hub (dist/bin.cjs):
 *
 *   - a hub with `SLAYZONE_HUB_SESSION_RETENTION_DAYS=90` sweeps on its own shortly
 *     after it listens: one `hub.retention.sweep` audit line, the 91-day content gone,
 *     the 89-day content and the task kept;
 *   - the desktop app's hub (supervised, nothing set) never sweeps: no timer, no audit
 *     line, content of any age kept.
 *
 * session-retention.test.ts pins the sweep and its schedule; this proves the boot wires
 * it (composition.ts) and that the default is off. A malformed period (B16) is in
 * hub-boot.test.ts with the other refusals.
 *
 * Native ABI: better-sqlite3 needs Electron's node.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/session-retention-boot.test.ts
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { migrations } from '../../../shared/db-migrations/src/index.js'
import { BOOT_SWEEP_DELAY_MS } from './session-retention.js'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const PACKAGES_DIR = join(HUB_DIR, '..', '..')
const ELECTRON_BIN = require('electron') as unknown as string
const DB_FILE = 'slayzone.data.sqlite'
const DAY = 24 * 60 * 60 * 1000

/** Newest source mtime under `dir`, skipping build output and dependencies. */
function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

/** The bundle inlines every workspace package, so staleness is judged on all of them. */
function ensureBuilt(): void {
  const stale = !existsSync(HUB_BIN) || newestMtime(PACKAGES_DIR) > statSync(HUB_BIN).mtimeMs
  if (!stale) return
  console.log('  … building hub bundle (bin missing or stale)')
  execFileSync('node', ['build.mjs'], { cwd: HUB_DIR, stdio: 'inherit' })
  if (!existsSync(HUB_BIN)) throw new Error(`hub build did not produce ${HUB_BIN}`)
}

function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null || /^(SLAYZONE_|ELECTRON_)/.test(k)) continue
    out[k] = v
  }
  return out
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v != null) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

interface Hub {
  logs: string[]
  stop: () => Promise<void>
}

async function bootHub(root: string, env: Record<string, string>): Promise<Hub> {
  const logs: string[] = []
  // stdin held open: a hub started by the desktop app treats stdin EOF as "parent died".
  const proc: ChildProcess = spawn(ELECTRON_BIN, [HUB_BIN], {
    cwd: root,
    env: { ...scrubbedEnv(), ...env, SLAYZONE_ROOT: root, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const cap = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) logs.push(line)
  }
  proc.stdout?.on('data', cap)
  proc.stderr?.on('data', cap)
  const stop = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
      const t = setTimeout(() => proc.kill('SIGKILL'), 5_000)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      proc.kill('SIGTERM')
    })
  try {
    await poll(
      async () => logs.find((l) => l.includes('listening on http://')) ?? null,
      40_000,
      `hub listening line (logs:\n${logs.join('\n')})`
    )
    return { logs, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

/** A current database with a task and session content aged 91 and 89 days. */
function seed(root: string, oldDays: number, newDays: number): void {
  const db = new Database(join(root, DB_FILE))
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    for (const m of migrations) {
      db.transaction(() => {
        m.up(db)
        db.pragma(`user_version = ${m.version}`)
      })()
    }
    const now = Date.now()
    const text = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
    db.prepare(`INSERT INTO projects (id, name, color) VALUES ('p1', 'Project', '#111111')`).run()
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, status, priority, description)
       VALUES ('t1', 'p1', 'Task', 'in_progress', 3, 'notes')`
    ).run()
    db.prepare(
      `INSERT INTO terminal_tabs (id, task_id, mode, is_main) VALUES ('tab1', 't1', 'claude-code', 1)`
    ).run()
    const event = db.prepare(
      'INSERT INTO chat_events (tab_id, seq, event, created_at) VALUES (?, ?, ?, ?)'
    )
    event.run('tab1', 0, '{"type":"text","text":"old"}', text(now - oldDays * DAY))
    event.run('tab1', 1, '{"type":"text","text":"new"}', text(now - newDays * DAY))
    const prompt = db.prepare(
      `INSERT INTO agent_prompts (id, task_id, agent_id, text, created_at) VALUES (?, 't1', 'claude-code', ?, ?)`
    )
    prompt.run('pr-old', 'old', now - oldDays * DAY)
    prompt.run('pr-new', 'new', now - newDays * DAY)
  } finally {
    db.close()
  }
}

/** Read the hub's database after it stopped. */
function contents(root: string): { events: number[]; prompts: string[]; tasks: string[] } {
  const db = new Database(join(root, DB_FILE), { readonly: true })
  try {
    return {
      events: (
        db.prepare('SELECT seq FROM chat_events ORDER BY seq').all() as { seq: number }[]
      ).map((r) => r.seq),
      prompts: (
        db.prepare('SELECT id FROM agent_prompts ORDER BY id').all() as { id: string }[]
      ).map((r) => r.id),
      tasks: (db.prepare('SELECT id FROM tasks ORDER BY id').all() as { id: string }[]).map(
        (r) => r.id
      )
    }
  } finally {
    db.close()
  }
}

const roots: string[] = []
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'slz-retention-boot-'))
  roots.push(root)
  return root
}

const sweepLines = (logs: string[]): string[] =>
  logs.filter((l) => l.startsWith('{"type":"security"') && l.includes('"hub.retention.sweep"'))

beforeAll(() => ensureBuilt())
const LOOP = { SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0' }

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

test('a hub with a 90-day period sweeps shortly after it listens', async () => {
  const root = newRoot()
  seed(root, 91, 89)
  const hub = await bootHub(root, { ...LOOP, SLAYZONE_HUB_SESSION_RETENTION_DAYS: '90' })
  try {
    const line = await poll(
      async () => sweepLines(hub.logs)[0] ?? null,
      BOOT_SWEEP_DELAY_MS + 20_000,
      `the boot sweep's audit line (logs:\n${hub.logs.join('\n')})`
    )
    const event = JSON.parse(line) as {
      outcome: string
      detail: { days: number; deleted: { table: string; rows: number }[] }
    }
    expect(event.outcome, `success: ${line}`).toBe('success')
    expect(event.detail.days, `period: ${line}`).toBe(90)
    const rows = Object.fromEntries(event.detail.deleted.map((d) => [d.table, d.rows]))
    expect(rows.chat_events, `counts: ${line}`).toBe(1)
    expect(rows.agent_prompts, `counts: ${line}`).toBe(1)
  } finally {
    await hub.stop()
  }
  const after = contents(root)
  expect(after.events, `chat events: ${after.events}`).toEqual([1])
  expect(after.prompts, `prompts: ${after.prompts}`).toEqual(['pr-new'])
  expect(after.tasks, `tasks: ${after.tasks}`).toEqual(['t1'])
})

test('the desktop app’s hub (supervised, nothing set) never sweeps', async () => {
  const root = newRoot()
  seed(root, 400, 300)
  const hub = await bootHub(root, {
    ...LOOP,
    SLAYZONE_SUPERVISED: '1',
    SLAYZONE_HUB_REQUIRE_LOGIN: '0'
  })
  try {
    // Past the moment a boot sweep would have run.
    await new Promise((r) => setTimeout(r, BOOT_SWEEP_DELAY_MS + 3_000))
    expect(sweepLines(hub.logs), `no sweep:\n${hub.logs.join('\n')}`).toHaveLength(0)
    expect(
      hub.logs.some((l) => l.includes('[session-retention]')),
      'no retention schedule announced'
    ).toBe(false)
  } finally {
    await hub.stop()
  }
  const after = contents(root)
  expect(after.events, `chat events: ${after.events}`).toEqual([0, 1])
  expect(after.prompts, `prompts: ${after.prompts}`).toEqual(['pr-new', 'pr-old'])
})
