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
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { TEST_OPT_IN_ENV } from './caller-env'

// Captured before anything below sets a var of its own.
const inheritedAtLoad = Object.keys(process.env)
  .filter((k) => k.startsWith('SLAYZONE_') && !TEST_OPT_IN_ENV.has(k))
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
