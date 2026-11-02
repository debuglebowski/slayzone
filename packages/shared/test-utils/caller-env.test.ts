/**
 * No test reaches a hub, computer, relay or hook endpoint it did not start itself,
 * whatever env the caller ran it from (caller-env.ts). Unit and CLI suites run from a
 * SlayZone task terminal inherited that terminal's live wiring, and the CLI REST suites
 * sent their calls through it to the user's real hub.
 *
 * Every SlayZone channel of the poisoned caller env below points at ONE sentinel
 * listener this file starts; a correct run never touches it.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { stripCallerSlayzoneEnv, TEST_OPT_IN_ENV } from './caller-env'

const rootDir = resolve(import.meta.dirname, '../../..')

let sentinel: Server
let sentinelAddr = ''
const sentinelHits: string[] = []
let sentinelRoot = ''

beforeAll(async () => {
  sentinel = createServer((req, res) => {
    sentinelHits.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true,"data":[]}')
  })
  await new Promise<void>((r) => sentinel.listen(0, '127.0.0.1', r))
  sentinelAddr = `127.0.0.1:${(sentinel.address() as AddressInfo).port}`
  sentinelRoot = mkdtempSync(join(tmpdir(), 'slz-caller-env-sentinel-root-'))
})

afterAll(async () => {
  await new Promise<void>((r) => sentinel.close(() => r()))
  rmSync(sentinelRoot, { recursive: true, force: true })
})

/** What a SlayZone task terminal carries, every endpoint aimed at the sentinel. */
function poisonedCallerEnv(): Record<string, string> {
  return {
    SLAYZONE_HUB_ADDRESS: sentinelAddr,
    SLAYZONE_HUB_TOKEN: 'sentinel-hub-token',
    SLAYZONE_CLI_RELAY_ADDRESS: sentinelAddr,
    SLAYZONE_CLI_RELAY_TOKEN: 'sentinel-relay-token',
    SLAYZONE_DESKTOP_BRIDGE_ADDRESS: sentinelAddr,
    SLAYZONE_AGENT_HOOK_URL: `http://${sentinelAddr}/api/agent-hook`,
    SLAYZONE_TASK_ID: 'sentinel-task',
    SLAYZONE_PROJECT_ID: 'sentinel-project',
    SLAYZONE_AGENT_ID: 'sentinel-agent',
    SLAYZONE_ROOT: sentinelRoot,
    SLAYZONE_RELEASE_CHANNEL: 'dev',
    SLAYZONE_NOT_IN_ANY_MANIFEST: 'x'
  }
}

describe('stripCallerSlayzoneEnv', () => {
  test('removes every SLAYZONE_* (global-scoped and unmanifested too), keeps the rest', () => {
    const env: NodeJS.ProcessEnv = {
      ...poisonedCallerEnv(),
      SLAYZONE_DEV: '1',
      SLAYZONE_REAL_STORE_FIXTURE: '/tmp/store.sqlite',
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1'
    }
    const removed = stripCallerSlayzoneEnv(env)
    expect(env).toEqual({
      SLAYZONE_REAL_STORE_FIXTURE: '/tmp/store.sqlite',
      PATH: '/usr/bin',
      ELECTRON_RUN_AS_NODE: '1'
    })
    expect(removed).toEqual([...Object.keys(poisonedCallerEnv()), 'SLAYZONE_DEV'].sort())
  })

  test('the opt-in knobs name no endpoint, credential, identity or root', () => {
    for (const key of TEST_OPT_IN_ENV) {
      expect(key).not.toMatch(/_(ADDRESS|URL|TOKEN|SECRET|ID|ROOT)$/)
    }
  })
})

describe('a harness run from a poisoned caller env', () => {
  test('a spawned slay never reaches the caller hub/relay (nested vitest, harness config)', async () => {
    const slayBin = join(rootDir, 'packages/apps/cli/dist/slay.js')
    expect(existsSync(slayBin), `${slayBin} not built (harness globalSetup builds it)`).toBe(true)
    const before = sentinelHits.length
    // Run as a developer runs one harness file by hand: vitest under the harness config,
    // straight from the terminal — no runners.sh in between.
    const env: NodeJS.ProcessEnv = { ...process.env, ...poisonedCallerEnv() }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    const result = await new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(
        process.execPath,
        [
          join(rootDir, 'node_modules/vitest/vitest.mjs'),
          'run',
          '--config',
          join(rootDir, 'packages/shared/test-utils/caller-env.fixture.config.ts')
        ],
        { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.on('close', (code) => done({ code, out }))
    })
    expect(sentinelHits.slice(before), 'requests that reached the caller env sentinel').toEqual([])
    expect(result.code, result.out).toBe(0)
  })

  test('runners.sh (pnpm test:unit, CI) starts every lane without them', () => {
    const out = execFileSync(
      'bash',
      ['-c', 'source "$1" >/dev/null && env', '_', join(import.meta.dirname, 'runners.sh')],
      {
        cwd: rootDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...poisonedCallerEnv(),
          SLAYZONE_CODEX_DRIFT_STRICT: '1'
        }
      }
    )
    const left = out
      .split('\n')
      .map((line) => line.slice(0, line.indexOf('=')))
      .filter((k) => k.startsWith('SLAYZONE_'))
      .sort()
    expect(left).toEqual(['SLAYZONE_CODEX_DRIFT_STRICT'])
  })
})

/**
 * Every root a test process starts from strips the caller env. A config is evaluated in
 * the runner's main process before any worker forks, so its strip covers the workers
 * and everything they spawn — including a direct `pnpm --filter <pkg> test`, which
 * never goes through runners.sh.
 */
describe('every test runner config strips the caller env', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.startsWith('packages/') && !f.includes('/node_modules/'))

  const vitestConfigs = tracked.filter((f) => /(^|\/)vitest(\.[\w-]+)?\.config\.ts$/.test(f))
  const playwrightConfigs = tracked.filter((f) =>
    /(^|\/)playwright(\.[\w-]+)?\.config\.ts$/.test(f)
  )

  test.each([...vitestConfigs, ...playwrightConfigs])('%s', (file) => {
    expect(readFileSync(join(rootDir, file), 'utf8')).toMatch(/\bstripCallerSlayzoneEnv\(\)/)
  })

  test('every package whose `test` runs vitest has its own vitest.config.ts', () => {
    const missing = tracked
      .filter((f) => f.endsWith('/package.json'))
      .filter((f) => {
        const pkg = JSON.parse(readFileSync(join(rootDir, f), 'utf8')) as {
          scripts?: Record<string, string>
        }
        return /\bvitest\b/.test(pkg.scripts?.test ?? '')
      })
      .map((f) => dirname(f))
      .filter((dir) => !existsSync(join(rootDir, dir, 'vitest.config.ts')))
    expect(missing).toEqual([])
  })
})
