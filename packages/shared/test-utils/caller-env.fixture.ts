/**
 * Run ONLY by caller-env.test.ts, as a nested harness vitest whose caller env points
 * every SlayZone channel at a sentinel listener (not a *.test.ts, so no runner collects
 * it on its own).
 *
 * It does what the CLI REST suites do (tasks-rest.test.ts `runCli`): start its own
 * hub stand-in, then spawn the bundled `slay` with `...process.env` plus the three vars
 * it means to set. Before the fix, the inherited `SLAYZONE_TASK_ID` made that child a
 * "task terminal" and the inherited `SLAYZONE_CLI_RELAY_*` outranked the test's own
 * `SLAYZONE_HUB_ADDRESS`: the call went to the caller's relay, i.e. the user's hub.
 *
 * The last two do what the CLI fallback suites do (tasks-rest.test.ts "app-down"):
 * spawn `slay` with `SLAYZONE_HUB_ADDRESS` deleted. The caller's HOME holds a hub
 * target and the caller's hub port block holds a hub, both aimed at the sentinel.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DEFAULT_HUB_PORT_BLOCK,
  HUB_PORT_BLOCK,
  SIDECAR_FIXED_PORT
} from '@slayzone/platform/paths'
import { expect, test } from 'vitest'
import { TEST_ISOLATION_ENV, TEST_OPT_IN_ENV } from './caller-env'

// Captured before anything below sets a var of its own.
const inheritedAtLoad = Object.keys(process.env)
  .filter((k) => k.startsWith('SLAYZONE_') && !TEST_OPT_IN_ENV.has(k) && !TEST_ISOLATION_ENV.has(k))
  .sort()

const SLAY_BIN = resolve(import.meta.dirname, '../../apps/cli/dist/slay.js')

test('a spawned slay reaches only the hub stand-in its test started', async () => {
  expect(existsSync(SLAY_BIN), `${SLAY_BIN} not built`).toBe(true)
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('[]')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const root = mkdtempSync(join(tmpdir(), 'slz-caller-env-'))
  try {
    await new Promise<void>((done) => {
      const child = spawn('node', [SLAY_BIN, 'projects', 'list'], {
        env: {
          ...process.env,
          SLAYZONE_ROOT: root,
          SLAYZONE_DEV: '1',
          SLAYZONE_HUB_ADDRESS: `127.0.0.1:${port}`
        },
        stdio: 'ignore'
      })
      child.on('close', () => done())
      child.on('error', () => done())
    })
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(root, { recursive: true, force: true })
  }
  expect(hits.length, 'the CLI never called the hub stand-in this test started').toBeGreaterThan(0)
  expect(inheritedAtLoad, 'SLAYZONE_* vars inherited from the caller').toEqual([])
})

/** Run the bundled `slay` with `...process.env` and the given overrides (undefined = delete). */
function runSlay(args: string[], overrides: Record<string, string | undefined>): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  return new Promise((done) => {
    let out = ''
    const child = spawn('node', [SLAY_BIN, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', () => done(out))
    child.on('error', (e) => done(String(e)))
  })
}

/**
 * Checked BEFORE anything binds or spawns: on the shipped block a fallback probe or
 * sweep from here would dial the developer's running app.
 */
function expectMovedBlock(): void {
  expect(
    HUB_PORT_BLOCK.end < DEFAULT_HUB_PORT_BLOCK.start ||
      HUB_PORT_BLOCK.start > DEFAULT_HUB_PORT_BLOCK.end,
    'the runner did not move the hub port block off the shipped one'
  ).toBe(true)
}

// With no hub address the CLI falls back to (a) the hub target stored under $HOME and
// (b) the desktop app's fixed loopback port. The caller's HOME and that port are the
// developer's live install; the runner must have swapped both for throwaways.
test('no hub address: the fallback reads no caller home and probes no caller port', async () => {
  expectMovedBlock()
  const root = mkdtempSync(join(tmpdir(), 'slz-caller-env-'))
  try {
    for (const args of [
      ['projects', 'list'],
      ['hub', 'users', 'ls']
    ]) {
      await runSlay(args, {
        SLAYZONE_ROOT: root,
        SLAYZONE_DEV: '1',
        SLAYZONE_HUB_ADDRESS: undefined
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  // Pass/fail is the caller's sentinel count; this file only drives the calls.
  expect(true).toBe(true)
})

test('no hub address: the fallback reaches the stand-in on the runner-moved fixed port', async () => {
  expectMovedBlock()
  const root = mkdtempSync(join(tmpdir(), 'slz-caller-env-'))
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      req.url === '/health' ? JSON.stringify({ ok: true, name: 'stand-in', root, pid: 1 }) : '[]'
    )
  })
  await new Promise<void>((r) => server.listen(SIDECAR_FIXED_PORT.dev, '127.0.0.1', r))
  try {
    await runSlay(['projects', 'list'], {
      SLAYZONE_ROOT: root,
      SLAYZONE_DEV: '1',
      SLAYZONE_HUB_ADDRESS: undefined
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(root, { recursive: true, force: true })
  }
  expect(hits[0], 'the fallback probed the moved dev port').toBe('GET /health')
  expect(hits.length, 'the CLI acted on the stand-in it found there').toBeGreaterThan(1)
})
