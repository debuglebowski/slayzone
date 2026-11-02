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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  DEFAULT_HUB_PORT_BLOCK,
  HUB_PORT_BLOCK,
  TEST_HUB_PORT_BLOCK_START_ENV
} from '@slayzone/platform/paths'
import { ENV_MANIFEST } from '@slayzone/platform/env-manifest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  isolateFromCaller,
  stripCallerSlayzoneEnv,
  TEST_HUB_PORT_BLOCK_ENV,
  TEST_ISOLATION_ENV,
  TEST_OPT_IN_ENV
} from './caller-env'

const rootDir = resolve(import.meta.dirname, '../../..')

let sentinel: Server
let sentinelPort = 0
let sentinelAddr = ''
const sentinelHits: string[] = []
let sentinelRoot = ''
/** Stands in for the developer's real `$HOME`: holds a hub target aimed at the sentinel. */
let sentinelHome = ''

/**
 * Bind the sentinel on a port that can be the dev port of a caller's hub port block
 * (block start = port - 1): clear of the shipped block and of this run's own block,
 * and with room for the 100-port block below 65536.
 */
async function listenSentinel(server: Server): Promise<number> {
  for (;;) {
    const port = 2_000 + Math.floor(Math.random() * 60_000)
    const start = port - 1
    const clear = (b: { start: number; end: number }): boolean =>
      start + 99 < b.start || start > b.end
    if (!clear(DEFAULT_HUB_PORT_BLOCK) || !clear(HUB_PORT_BLOCK)) continue
    const bound = await new Promise<boolean>((done) => {
      server.once('error', () => done(false))
      server.listen(port, '127.0.0.1', () => done(true))
    })
    if (bound) return port
  }
}

beforeAll(async () => {
  sentinel = createServer((req, res) => {
    sentinelHits.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    // Hub-shaped, so a fallback probe that reached it would accept it as a hub.
    res.end(
      req.url === '/health'
        ? JSON.stringify({ ok: true, name: 'sentinel', root: sentinelRoot, pid: 1 })
        : '{"ok":true,"data":[]}'
    )
  })
  sentinelPort = await listenSentinel(sentinel)
  sentinelAddr = `127.0.0.1:${sentinelPort}`
  sentinelRoot = mkdtempSync(join(tmpdir(), 'slz-caller-env-sentinel-root-'))
  sentinelHome = mkdtempSync(join(tmpdir(), 'slz-caller-env-sentinel-home-'))
  // Every file the CLI reads a hub from when no address is set (cli-state.ts): the
  // stored target per channel, the pre-move location, and a live break-glass session.
  const target = JSON.stringify({ url: `http://${sentinelAddr}`, token: 'sentinel-file-token' })
  const cliDir = join(sentinelHome, '.slayzone', 'cli')
  mkdirSync(cliDir, { recursive: true })
  for (const name of ['hub-target.json', 'hub-target.dev.json']) {
    writeFileSync(join(cliDir, name), target)
  }
  writeFileSync(join(sentinelHome, '.slayzone', 'cli-hub-target.json'), target)
  const session = JSON.stringify({
    url: `http://${sentinelAddr}`,
    token: 'sentinel-break-glass-token',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  })
  for (const name of ['break-glass.json', 'break-glass.dev.json']) {
    writeFileSync(join(cliDir, name), session)
  }
})

afterAll(async () => {
  await new Promise<void>((r) => sentinel.close(() => r()))
  rmSync(sentinelRoot, { recursive: true, force: true })
  rmSync(sentinelHome, { recursive: true, force: true })
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

/**
 * The caller's home and hub port block, aimed at the sentinel: what a CLI with no hub
 * address falls back to. The block is the one test seam for "the desktop app's fixed
 * port" (paths.ts); its dev port here IS the sentinel.
 */
function poisonedCallerHome(): Record<string, string> {
  return {
    HOME: sentinelHome,
    USERPROFILE: sentinelHome,
    [TEST_HUB_PORT_BLOCK_ENV]: String(sentinelPort - 1)
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
  test('a spawned slay never reaches the caller hub/relay/home/port block (nested vitest, harness config)', async () => {
    const slayBin = join(rootDir, 'packages/apps/cli/dist/slay.js')
    expect(existsSync(slayBin), `${slayBin} not built (harness globalSetup builds it)`).toBe(true)
    const before = sentinelHits.length
    // Run as a developer runs one harness file by hand: vitest under the harness config,
    // straight from the terminal — no runners.sh in between.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...poisonedCallerEnv(),
      ...poisonedCallerHome()
    }
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

  test('runners.sh (pnpm test:unit, CI) starts every lane without them, in a throwaway home', () => {
    const out = execFileSync(
      'bash',
      ['-c', 'source "$1" >/dev/null && env', '_', join(import.meta.dirname, 'runners.sh')],
      {
        cwd: rootDir,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...poisonedCallerEnv(),
          ...poisonedCallerHome(),
          SLAYZONE_CODEX_DRIFT_STRICT: '1'
        }
      }
    )
    const env = new Map(
      out
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    )
    const left = [...env.keys()].filter((k) => k.startsWith('SLAYZONE_')).sort()
    expect(left).toEqual(['SLAYZONE_CODEX_DRIFT_STRICT', ...TEST_ISOLATION_ENV].sort())
    expect(env.get('HOME'), 'HOME').not.toBe(sentinelHome)
    expect(env.get('USERPROFILE'), 'USERPROFILE').toBe(env.get('HOME'))
    const start = Number(env.get(TEST_HUB_PORT_BLOCK_ENV))
    expect(start, 'the caller hub port block').not.toBe(sentinelPort - 1)
    expect(start + 99 < DEFAULT_HUB_PORT_BLOCK.start || start > DEFAULT_HUB_PORT_BLOCK.end).toBe(
      true
    )
  })
})

describe('isolateFromCaller', () => {
  test('moves the block paths.ts reads, which no terminal or agent inherits', () => {
    expect(TEST_HUB_PORT_BLOCK_ENV).toBe(TEST_HUB_PORT_BLOCK_START_ENV)
    expect(ENV_MANIFEST[TEST_HUB_PORT_BLOCK_ENV]).toBe('infra')
    for (const key of TEST_ISOLATION_ENV) expect(TEST_OPT_IN_ENV.has(key), key).toBe(false)
  })

  test('this very file runs on a moved block, in a throwaway home', () => {
    expect(
      HUB_PORT_BLOCK.end < DEFAULT_HUB_PORT_BLOCK.start ||
        HUB_PORT_BLOCK.start > DEFAULT_HUB_PORT_BLOCK.end
    ).toBe(true)
    expect(process.env.HOME).toMatch(/slz-test-home-/)
  })

  test('replaces HOME, the XDG/AppData dirs and the hub port block, whatever the caller set', () => {
    const env: NodeJS.ProcessEnv = {
      ...poisonedCallerEnv(),
      ...poisonedCallerHome(),
      XDG_CONFIG_HOME: join(sentinelHome, '.config'),
      XDG_STATE_HOME: join(sentinelHome, '.local', 'state'),
      XDG_DATA_HOME: join(sentinelHome, '.local', 'share'),
      PATH: '/usr/bin'
    }
    const { home, cleanup } = isolateFromCaller(env)
    try {
      expect(home).not.toBe(sentinelHome)
      expect(existsSync(home), 'the throwaway home exists').toBe(true)
      expect(env.HOME).toBe(home)
      expect(env.USERPROFILE).toBe(home)
      for (const key of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) {
        expect(env[key] ?? '', key).not.toContain(sentinelHome)
      }
      expect(env[TEST_HUB_PORT_BLOCK_ENV]).not.toBe(String(sentinelPort - 1))
      expect(env.PATH).toBe('/usr/bin')
      const slayzone = Object.keys(env).filter((k) => k.startsWith('SLAYZONE_'))
      expect(slayzone.sort()).toEqual([...TEST_ISOLATION_ENV].sort())
    } finally {
      cleanup()
    }
    expect(existsSync(home), 'cleanup removes the throwaway home').toBe(false)
  })
})

/**
 * Every root a test process starts from isolates it from the caller. A config is
 * evaluated in the runner's main process before any worker forks, so its isolation
 * covers the workers and everything they spawn — including a direct
 * `pnpm --filter <pkg> test`, which never goes through runners.sh.
 */
describe('every test runner config isolates from the caller', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: rootDir, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.startsWith('packages/') && !f.includes('/node_modules/'))

  const vitestConfigs = tracked.filter((f) => /(^|\/)vitest(\.[\w-]+)?\.config\.ts$/.test(f))
  const playwrightConfigs = tracked.filter((f) =>
    /(^|\/)playwright(\.[\w-]+)?\.config\.ts$/.test(f)
  )

  test.each([...vitestConfigs, ...playwrightConfigs])('%s', (file) => {
    const src = readFileSync(join(rootDir, file), 'utf8')
    // Bare call (process.env, fresh home) everywhere but Playwright, whose app under
    // test must keep the real home (isolateFromCaller `keepHome` says why).
    if (file === 'packages/apps/app/playwright.config.ts') {
      expect(src).toMatch(/\bisolateFromCaller\(process\.env, \{ keepHome: true \}\)/)
    } else {
      expect(src).toMatch(/\bisolateFromCaller\(\)/)
      expect(src).not.toMatch(/keepHome/)
    }
  })

  // A test that hands a child an env with every SLAYZONE_* dropped (to keep the
  // caller's wiring out) would drop the runner's moved hub port block with it: a
  // `slay` there with no address would sweep the shipped block, where the developer's
  // app runs. So every such scrub keeps TEST_ISOLATION_ENV.
  const blanketScrub = /\^\(?SLAYZONE_|startsWith\(\s*['"`]SLAYZONE_['"`]\s*\)/
  const testSources = tracked.filter(
    (f) =>
      /\.(test|spec)\.(ts|tsx|mjs)$/.test(f) ||
      /\/e2e\/.*\.ts$/.test(f) ||
      f.startsWith('packages/shared/test-utils/')
  )
  test('every test source that drops all SLAYZONE_* from a child env keeps TEST_ISOLATION_ENV', () => {
    const offenders = testSources.filter((f) => {
      if (f.startsWith('packages/shared/test-utils/caller-env')) return false
      const src = readFileSync(join(rootDir, f), 'utf8')
      return blanketScrub.test(src) && !src.includes('TEST_ISOLATION_ENV')
    })
    expect(offenders).toEqual([])
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
