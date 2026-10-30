/**
 * Device sign-in (T-14) through the REAL built hub and the REAL built CLI: a hub with
 * Entra sign-in on and password sign-in off, `slay hub login` run as a child process,
 * and the browser leg driven over HTTP the way a browser would (cookie jar, Origin).
 *
 * Entra is a LOCAL fake behind a test-only fetch preload (sso-hub-harness.ts, shared with
 * hub-app-sign-in.test.ts). Nothing reaches Microsoft; no product code knows about it.
 *
 * Proves: the CLI's device sign-in completes after browser approval with MFA and its
 * bearer works on the REST API; denial is a clean CLI error; no token without MFA;
 * `slay hub login --email` is refused on a hub with password sign-in off; the audit
 * lines name the flow and carry no code or token; `MISSING_OR_NULL_ORIGIN` no longer
 * hits `slay hub login` (password sign-in on a password hub) while a cookie request with
 * no Origin is still refused.
 *
 * Run with: vitest (packages/shared/test-utils/vitest.harness.config.ts)
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Browser,
  ensureBuilt,
  type FakeEntra,
  HUB_BIN,
  HUB_DIR,
  MFA,
  PUBLIC,
  PUBLIC_ORIGIN,
  scrubbedEnv,
  startHub,
  startSsoHub,
  waitFor
} from './sso-hub-harness'

const ELECTRON_BIN = createRequire(import.meta.url)('electron') as unknown as string

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_DIR = join(__dirname, '..', '..', 'cli')
const CLI_BIN = join(CLI_DIR, 'dist', 'slay.js')
const NODE_BIN = process.env.SLZ_TEST_NODE ?? 'node'

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

interface Cli {
  out: () => string
  exit: Promise<number | null>
  kill: () => void
}

function runCli(home: string, args: string[]): Cli {
  let out = ''
  const proc = spawn(NODE_BIN, [CLI_BIN, ...args], {
    env: { ...scrubbedEnv(), HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout?.on('data', (b: Buffer) => (out += b.toString()))
  proc.stderr?.on('data', (b: Buffer) => (out += b.toString()))
  return {
    out: () => out,
    exit: new Promise((r) => proc.once('exit', (code) => r(code))),
    kill: () => proc.kill('SIGKILL')
  }
}

/** The page + code `slay hub login` printed. The page is on the public address. */
async function printedCode(cli: Cli): Promise<{ page: URL; code: string }> {
  const code = await waitFor(
    () => /shows this code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(cli.out())?.[1],
    `the CLI to print a code:\n${cli.out()}`
  )
  const page = /^\s+(https:\/\/\S+)$/m.exec(cli.out())?.[1]
  expect(page, `the CLI printed the page: ${cli.out()}`).toBeTruthy()
  return { page: new URL(page!), code }
}

let tmp = ''
let entra: FakeEntra
let hub: Awaited<ReturnType<typeof startHub>>
const secrets: string[] = []

beforeAll(async () => {
  await ensureBuilt(HUB_DIR, HUB_BIN)
  await ensureBuilt(CLI_DIR, CLI_BIN)
  tmp = mkdtempSync(join(tmpdir(), 'slz-hub-device-'))
  ;({ hub, entra } = await startSsoHub(ELECTRON_BIN, tmp))
})

afterAll(async () => {
  await entra?.stop()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

describe('a hub with Entra sign-in on and password sign-in off', () => {
  afterAll(async () => {
    await hub?.stop()
  })

  test('the hub reports SSO on and password off', async () => {
    const health = (await (await fetch(`${hub.base}/health`)).json()) as {
      switches?: Record<string, boolean>
    }
    expect(health.switches?.enableSso, 'enableSso').toBe(true)
    expect(health.switches?.enablePassword, 'enablePassword off').toBe(false)
  })

  test('slay hub login: device sign-in, browser approval with MFA, bearer works on REST', async () => {
    const home = join(tmp, 'home-ok')
    const cli = runCli(home, ['hub', 'login', hub.base, '--no-browser'])
    try {
      const { page, code } = await printedCode(cli)
      expect(page.origin, `page on the public address, got ${page.origin}`).toBe(PUBLIC_ORIGIN)
      expect(page.pathname, `page path, got ${page.pathname}`).toBe('/device')
      secrets.push(code.replace('-', ''))
      const browser = new Browser(hub, entra)
      const view = await browser.open(page, MFA)
      const html = await view.text()
      expect(view.status, `approval page, got ${view.status}: ${html.slice(0, 300)}`).toBe(200)
      expect(html, 'the page shows the same code').toContain(code)
      expect(html, 'the page names the client').toContain('SlayZone CLI (slay)')
      expect(html, 'the page names the hub').toContain(PUBLIC)
      expect(!/<script/i.test(html), 'no script on the page').toBe(true)
      // A cookie-authenticated POST without an Origin is refused.
      const noOrigin = await browser.post('/device/approve', { user_code: code }, null)
      expect(noOrigin.status, `no Origin → 403, got ${noOrigin.status}`).toBe(403)
      const ok = await browser.post('/device/approve', { user_code: code }, PUBLIC_ORIGIN)
      expect(ok.status, `approve → 200, got ${ok.status}`).toBe(200)
      const exit = await Promise.race([
        cli.exit,
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000))
      ])
      expect(exit, `CLI exit 0, got ${String(exit)}:\n${cli.out()}`).toBe(0)
      expect(cli.out(), `signed-in line:\n${cli.out()}`).toContain('as ada@normain.test')
      const stored = JSON.parse(
        readFileSync(join(home, '.slayzone', 'cli', 'hub-target.json'), 'utf8')
      ) as { url: string; token: string }
      secrets.push(stored.token)
      const tasks = await fetch(`${hub.base}/api/tasks`, {
        headers: { authorization: `Bearer ${stored.token}` }
      })
      expect(tasks.status, `GET /api/tasks with the bearer → 200, got ${tasks.status}`).toBe(200)
      const none = await fetch(`${hub.base}/api/tasks`)
      expect(none.status, `without it → 401, got ${none.status}`).toBe(401)

      // The browser's session cookie without an Origin is still refused by better-auth.
      const signOut = await fetch(`${hub.base}/api/auth/sign-out`, {
        method: 'POST',
        headers: { cookie: browser.cookie, 'content-type': 'application/json' },
        body: '{}'
      })
      const body = await signOut.text()
      expect(
        signOut.status,
        `cookie + no Origin → 403 MISSING_OR_NULL_ORIGIN, got ${signOut.status} ${body}`
      ).toBe(403)
      expect(
        body,
        `cookie + no Origin → 403 MISSING_OR_NULL_ORIGIN, got ${signOut.status} ${body}`
      ).toContain('MISSING_OR_NULL_ORIGIN')
    } finally {
      cli.kill()
    }
  })

  test('denial in the browser ends slay hub login with a clean error', async () => {
    const cli = runCli(join(tmp, 'home-deny'), ['hub', 'login', hub.base, '--no-browser'])
    try {
      const { page, code } = await printedCode(cli)
      secrets.push(code.replace('-', ''))
      const browser = new Browser(hub, entra)
      expect((await browser.open(page, MFA)).status, 'approval page').toBe(200)
      const denied = await browser.post('/device/deny', { user_code: code }, PUBLIC_ORIGIN)
      expect(denied.status, `deny → 200, got ${denied.status}`).toBe(200)
      const exit = await cli.exit
      expect(exit, `CLI exit 1, got ${String(exit)}`).toBe(1)
      expect(cli.out(), `denied message:\n${cli.out()}`).toContain('denied in the browser')
    } finally {
      cli.kill()
    }
  })

  test('no token without MFA: the sign-in is refused, the CLI keeps waiting', async () => {
    const cli = runCli(join(tmp, 'home-nomfa'), ['hub', 'login', hub.base, '--no-browser'])
    try {
      const { page, code } = await printedCode(cli)
      secrets.push(code.replace('-', ''))
      const browser = new Browser(hub, entra)
      const view = await browser.open(page, { oid: 'bob', amr: ['pwd'] })
      expect(view.status, `refused sign-in page, got ${view.status}`).toBe(401)
      const approve = await browser.post('/device/approve', { user_code: code }, PUBLIC_ORIGIN)
      expect(approve.status, `no session → approve refused, got ${approve.status}`).toBe(401)
      await new Promise((r) => setTimeout(r, 6_000))
      expect(cli.out(), 'still waiting').toContain('Waiting for approval')
      expect(cli.out(), `no token:\n${cli.out()}`).not.toContain('Signed in')
      expect(
        hub.logs.some((l) => l.includes('"event":"auth.signin"') && l.includes('"no_mfa"')),
        'auth.signin denied no_mfa audited'
      ).toBeTruthy()
    } finally {
      cli.kill()
    }
  })

  test('slay hub login --email is refused on a hub with password sign-in off', async () => {
    const cli = runCli(join(tmp, 'home-pw'), [
      'hub',
      'login',
      hub.base,
      '--email',
      'ada@normain.test',
      '--password',
      'x'
    ])
    const exit = await cli.exit
    expect(exit, `exit 1, got ${String(exit)}`).toBe(1)
    expect(cli.out(), `message:\n${cli.out()}`).toContain('Password sign-in is off')
  })

  test('audit: the flow is on the record, no code or token in any line', async () => {
    const security = hub.logs.filter((l) => l.startsWith('{"type":"security"'))
    const events = security.map((l) => {
      const e = JSON.parse(l) as { event: string; outcome: string; detail: { method?: string } }
      return `${e.event}:${e.outcome}${e.detail.method ? `:${e.detail.method}` : ''}`
    })
    for (const want of [
      'auth.device.code:success',
      'auth.device.approve:success',
      'auth.device.deny:success',
      'auth.signin:success:sso',
      'auth.signin:success:device'
    ]) {
      expect(events, `${want} audited (got ${events.join(', ')})`).toContain(want)
    }
    const all = hub.logs.join('\n')
    for (const s of secrets) expect(all, 'no code or token in the hub output').not.toContain(s)
  })
})

// A hub with password sign-in (no SSO): the CLI's password path. `fetch` sent
// `Sec-Fetch-Mode: cors`, which better-auth answered MISSING_OR_NULL_ORIGIN.
test('MISSING_OR_NULL_ORIGIN no longer hits slay hub login (password hub)', async () => {
  const root = join(tmp, 'pw-hub')
  mkdirSync(root)
  const pwHub = await startHub(ELECTRON_BIN, root, {
    SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
    SLAYZONE_HUB_REQUIRE_LOGIN: '1'
  })
  try {
    const owner = await waitFor(() => {
      try {
        return JSON.parse(readFileSync(join(root, 'hub.owner.json'), 'utf8')) as {
          email: string
          password: string
        }
      } catch {
        return null
      }
    }, 'hub.owner.json')
    const cli = runCli(join(tmp, 'home-pwhub'), [
      'hub',
      'login',
      pwHub.base,
      '--email',
      owner.email,
      '--password',
      owner.password
    ])
    const exit = await cli.exit
    expect(exit, `exit 0, got ${String(exit)}:\n${cli.out()}`).toBe(0)
    expect(cli.out(), 'no 403').not.toContain('403')
  } finally {
    await pwHub.stop()
  }
})
