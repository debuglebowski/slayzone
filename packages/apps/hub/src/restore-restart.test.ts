/**
 * Backup restore through the REAL built hub (dist/bin.cjs), as a standalone hub with
 * nothing to restart it (D2, D6): the restore is staged, the hub exits 75, and the
 * next start swaps the backup in before it opens the database. Then:
 *   - the data equals the backup (a project made after it is gone), and the data
 *     from just before the restore is kept as a `restore` backup;
 *   - the integration-credential pass ran on the restored rows: a `plain:` token the
 *     backup carried is `hub1:` now, in no file of the hub;
 *   - the hub reports what it did (`app.backup.restoreStatus`).
 *
 * Native ABI: better-sqlite3 needs Electron's node.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/restore-restart.test.ts
 */
import { TEST_ISOLATION_ENV } from '../../../shared/test-utils/caller-env.js'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { afterAll, assert, beforeAll, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const PACKAGES_DIR = join(HUB_DIR, '..', '..')
const ELECTRON_BIN = require('electron') as unknown as string

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

function ensureBuilt(): void {
  const stale = !existsSync(HUB_BIN) || newestMtime(PACKAGES_DIR) > statSync(HUB_BIN).mtimeMs
  if (!stale) return
  execFileSync('node', ['build.mjs'], { cwd: HUB_DIR, stdio: 'inherit' })
}

function scrubbedEnv(home: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null || (/^(SLAYZONE_|ELECTRON_)/.test(k) && !TEST_ISOLATION_ENV.has(k))) continue
    out[k] = v
  }
  return { ...out, HOME: home }
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
  port: number
  logs: string[]
  exit: Promise<number | null>
  dbPath: string
  stop: () => Promise<void>
}

async function bootHub(root: string): Promise<Hub> {
  const logs: string[] = []
  const proc: ChildProcess = spawn(ELECTRON_BIN, [HUB_BIN], {
    cwd: root,
    env: {
      ...scrubbedEnv(root),
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
      ELECTRON_RUN_AS_NODE: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const cap = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) logs.push(line)
  }
  proc.stdout?.on('data', cap)
  proc.stderr?.on('data', cap)
  const exit = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)))
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
  const line = await poll(
    async () => logs.find((l) => l.includes('listening on http://')) ?? null,
    40_000,
    `hub listening line (logs:\n${logs.join('\n')})`
  )
  const port = Number(line.match(/http:\/\/[^:]+:(\d+)/)?.[1])
  const dbPath = line.match(/ db=([^)\s]+)/)?.[1] ?? ''
  await poll(
    async () => ((await fetch(`http://127.0.0.1:${port}/health`)).ok ? true : null),
    15_000,
    'hub /health ok'
  )
  return { port, logs, exit, dbPath, stop }
}

type Backup = { filename: string; type: string; name: string }
type Fault = { pass: string; key: string; message: string; dismissable?: boolean }
type Client = {
  computers: {
    listFaults: { query: (i: { computerId: string | null }) => Promise<Fault[]> }
    discardFault: {
      mutate: (i: {
        computerId: string | null
        origin: 'hub'
        source: 'ledger'
        pass: string
        key: string
      }) => Promise<unknown>
    }
  }
  app: {
    backup: {
      create: { mutate: (i?: { name?: string }) => Promise<Backup> }
      list: { query: () => Promise<Backup[]> }
      restore: {
        mutate: (i: {
          filename: string
        }) => Promise<{ restarting: boolean; respawner: string | null; preRestoreBackup: string }>
      }
      restoreStatus: {
        query: () => Promise<{
          bootId: string
          pending: unknown
          lastRestore: { status: string; backup: string } | null
        }>
      }
    }
  }
}

function hubClient(hub: Hub): { client: Client; close: () => void } {
  const ws = createWSClient({ url: `ws://127.0.0.1:${hub.port}/trpc?windowId=1` })
  const client = createTRPCClient({
    links: [wsLink({ client: ws, transformer: superjson })]
  }) as unknown as Client
  return { client, close: () => ws.close() }
}

async function createProject(hub: Hub, name: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${hub.port}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name })
  })
  expect(res.ok, `create project ${name}: ${res.status}`).toBe(true)
}

async function projectNames(hub: Hub): Promise<string[]> {
  const body = (await (await fetch(`http://127.0.0.1:${hub.port}/api/projects`)).json()) as {
    data: Array<{ name: string }>
  }
  return body.data.map((p) => p.name)
}

function allFiles(dir: string, base = dir): Array<{ path: string; bytes: Buffer }> {
  const out: Array<{ path: string; bytes: Buffer }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...allFiles(full, base))
    else out.push({ path: relative(base, full), bytes: readFileSync(full) })
  }
  return out
}

const roots: string[] = []
beforeAll(() => ensureBuilt())
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

test('standalone restore: staged, exit 75, swapped in at the next start; tokens re-encrypted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slz-restore-restart-'))
  roots.push(root)
  const token = `lin_api_${randomBytes(18).toString('hex')}`

  const first = await bootHub(root)
  let backup: Backup
  let bootId: string
  try {
    await createProject(first, 'before-backup')
    const { client, close } = hubClient(first)
    try {
      backup = await client.app.backup.create.mutate({ name: 'the backup' })
      await createProject(first, 'after-backup')
      // The backup carries a token an older hub stored in plaintext.
      const Database = require('better-sqlite3') as typeof import('better-sqlite3')
      const b = new Database(join(root, 'backups', backup.filename))
      b.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
        'integration:credential:restored-ref',
        `plain:${token}`
      )
      b.pragma('wal_checkpoint(TRUNCATE)')
      b.close()

      bootId = (await client.app.backup.restoreStatus.query()).bootId
      const result = await client.app.backup.restore.mutate({ filename: backup.filename })
      expect(result).toMatchObject({ restarting: true, respawner: null })
      expect(result.preRestoreBackup).toMatch(/\.restore\.sqlite$/)
    } finally {
      close()
    }
    // Nothing restarts a hand-started hub: it stops with the restart code.
    expect(
      await Promise.race([first.exit, new Promise((r) => setTimeout(() => r('alive'), 20_000))])
    ).toBe(75)
  } finally {
    await first.stop()
  }
  assert(existsSync(join(root, 'restore.pending.json')), 'the restore is staged on disk')

  const second = await bootHub(root)
  try {
    expect(existsSync(join(root, 'restore.pending.json'))).toBe(false)
    const names = await projectNames(second)
    expect(names).toContain('before-backup')
    expect(names).not.toContain('after-backup')
    const { client, close } = hubClient(second)
    try {
      const status = await client.app.backup.restoreStatus.query()
      expect(status.bootId).not.toBe(bootId)
      expect(status.lastRestore).toEqual({ status: 'applied', backup: backup.filename })
      const listed = await client.app.backup.list.query()
      expect(listed.some((b) => b.type === 'restore')).toBe(true)
    } finally {
      close()
    }
    // The credential pass ran on the restored rows.
    await poll(
      async () => {
        const Database = require('better-sqlite3') as typeof import('better-sqlite3')
        const db = new Database(second.dbPath, { readonly: true })
        try {
          const row = db
            .prepare('SELECT value FROM settings WHERE key = ?')
            .get('integration:credential:restored-ref') as { value: string }
          const pending = db
            .prepare('SELECT 1 FROM settings WHERE key = ?')
            .get('integration.credentials_compaction_pending')
          return row.value.startsWith('hub1:') && !pending ? true : null
        } finally {
          db.close()
        }
      },
      20_000,
      'restored plaintext token re-encrypted'
    )
  } finally {
    await second.stop()
  }
  // The live database holds no copy; the backup the user restored from still does —
  // a backup is the user's file, never rewritten.
  const hits = allFiles(root)
    .filter((f) => f.bytes.includes(token))
    .map((f) => f.path)
  expect(hits).toEqual([join('backups', backup.filename)])
})

test('a restore refused at boot keeps the data and leaves a notice until dismissed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slz-restore-refused-'))
  roots.push(root)
  const first = await bootHub(root)
  let backup: Backup
  try {
    await createProject(first, 'kept')
    const { client, close } = hubClient(first)
    try {
      backup = await client.app.backup.create.mutate({ name: 'will go bad' })
      await client.app.backup.restore.mutate({ filename: backup.filename })
    } finally {
      close()
    }
    expect(
      await Promise.race([first.exit, new Promise((r) => setTimeout(() => r('alive'), 20_000))])
    ).toBe(75)
  } finally {
    await first.stop()
  }
  // The backup goes bad between staging and the next start.
  writeFileSync(join(root, 'backups', backup.filename), 'no longer a database')

  const second = await bootHub(root)
  try {
    expect(await projectNames(second)).toContain('kept')
    const { client, close } = hubClient(second)
    try {
      expect((await client.app.backup.restoreStatus.query()).lastRestore).toMatchObject({
        status: 'refused',
        backup: backup.filename
      })
      const notice = await poll(
        async () =>
          (await client.computers.listFaults.query({ computerId: null })).find(
            (f) => f.pass === 'hub-restore'
          ) ?? null,
        10_000,
        'refused-restore notice'
      )
      expect(notice).toMatchObject({ key: backup.filename, dismissable: true })
      await client.computers.discardFault.mutate({
        computerId: null,
        origin: 'hub',
        source: 'ledger',
        pass: 'hub-restore',
        key: backup.filename
      })
      expect(
        (await client.computers.listFaults.query({ computerId: null })).some(
          (f) => f.pass === 'hub-restore'
        )
      ).toBe(false)
    } finally {
      close()
    }
  } finally {
    await second.stop()
  }
})
