/**
 * The web shell is served by every hub — a REAL spawned hub, not a unit test of
 * `handleWebAssets` in isolation (which already has its own coverage in
 * web-assets.test.ts and knows nothing about login or addresses).
 *
 * WHAT CHANGED. The shell used to be served only under `SLAYZONE_MODE=remote` or a
 * supervised hub, so a browser session's scoped token (a real bearer, sent on every
 * request) never rode plain `http://` over a network. That concern now has a better
 * owner than a mode flag: a hub other machines can reach is refused at boot unless it
 * publishes a public address (rule B3) and requires login (B1), and clients dial that
 * address with `https://` through the front end that terminates TLS (rule A1). A hub
 * nobody else can reach is on loopback. So the shell is served unconditionally.
 *
 * What this exercises end to end: the default hub (login off), a login-required hub
 * and a hub started by the desktop app all serve the shell body, and `/health` reports
 * `authRequired` per the login switch — the exact bit the client boot branch
 * (`hub-health.ts`'s `fetchAuthRequired` + `main.tsx`) reads to decide whether to show
 * `LoginScreen`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/web-assets-served.test.ts
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, assert, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const ELECTRON_BIN = require('electron') as unknown as string

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

function ensureBuilt(): void {
  let needs = !existsSync(HUB_BIN)
  if (!needs) needs = newestMtime(join(HUB_DIR, 'src')) > statSync(HUB_BIN).mtimeMs
  if (!needs) return
  console.log('  … building hub bundle (bin missing or stale)')
  execFileSync('node', ['build.mjs'], { cwd: HUB_DIR, stdio: 'inherit' })
  if (!existsSync(HUB_BIN)) throw new Error(`hub build did not produce ${HUB_BIN}`)
}

/** The web shell's build output lands in the hub's dist/web; build it when it is absent. */
function ensureWebShell(): void {
  if (existsSync(join(HUB_DIR, 'dist', 'web', 'index.html'))) return
  console.log('  … building the web shell (dist/web missing)')
  execFileSync('pnpm', ['--filter', '@slayzone/web-shell', 'build'], {
    cwd: join(HUB_DIR, '..', '..', '..'),
    stdio: 'inherit'
  })
  if (!existsSync(join(HUB_DIR, 'dist', 'web', 'index.html'))) {
    throw new Error('web shell build did not produce dist/web/index.html')
  }
}

function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (/^(SLAYZONE_|ELECTRON_)/.test(k)) continue
    out[k] = v
  }
  return out
}

interface Proc {
  proc: ChildProcess
  logs: string[]
  stop: () => Promise<void>
}
function spawnChild(bin: string, env: Record<string, string>): Proc {
  const logs: string[] = []
  // stdin is a real PIPE (not 'ignore'), held open by simply never calling
  // `.end()` on it — a supervised hub (bin.ts) treats stdin EOF as "the
  // parent died" and self-terminates. 'ignore' connects fd 0 to /dev/null,
  // which reads as immediate EOF the instant the child calls
  // `process.stdin.resume()`, killing a supervised child within its first
  // tick — this is exactly what made the supervised case below hang the
  // /health poll until `stop()` (SIGTERM) finally cleaned it up.
  const proc = spawn(ELECTRON_BIN, [bin], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  proc.stdout?.on('data', (d) => logs.push(String(d)))
  proc.stderr?.on('data', (d) => logs.push(String(d)))
  return {
    proc,
    logs,
    stop: () =>
      new Promise((resolve) => {
        proc.once('exit', () => resolve())
        proc.kill('SIGTERM')
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL')
        }, 3_000)
      })
  }
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v != null) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** Spawn a hub with the given env, wait for it to listen + answer /health,
 *  and return its port. Shared by every case below so all go through the identical
 *  boot-and-poll sequence. */
async function spawnAndWait(
  root: string,
  extraEnv: Record<string, string>
): Promise<Proc & { port: number }> {
  const hub = spawnChild(HUB_BIN, {
    ...scrubbedEnv(),
    SLAYZONE_ROOT: root,
    SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
    ...extraEnv
  })
  const listen = await poll(
    async () => hub.logs.find((l) => l.includes('listening on http://')) ?? null,
    20_000,
    'hub listening line'
  )
  const m = listen.match(/http:\/\/(127\.0\.0\.1):(\d+)/)
  assert(m, `hub listening line parseable: ${listen}`)
  const port = Number(m[2])
  await poll(
    async () => {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000)
      })
      return r.ok ? true : null
    },
    15_000,
    'hub /health ok'
  )
  return Object.assign(hub, { port })
}

ensureBuilt()
ensureWebShell()

const cases: Array<{ name: string; env: Record<string, string>; authRequired: boolean }> = [
  { name: 'default (login off)', env: {}, authRequired: false },
  { name: 'login required', env: { SLAYZONE_HUB_REQUIRE_LOGIN: '1' }, authRequired: true },
  {
    name: 'started by the desktop app',
    env: { SLAYZONE_SUPERVISED: '1', SLAYZONE_HUB_REQUIRE_LOGIN: '0' },
    authRequired: false
  }
]
const roots: string[] = []
const hubs: Array<Proc & { port: number }> = []

afterAll(async () => {
  for (const h of hubs) await h.stop()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

for (const c of cases) {
  const root = mkdtempSync(join(tmpdir(), 'slz-web-served-'))
  roots.push(root)
  const hub = await spawnAndWait(root, c.env)
  hubs.push(hub)

  test(`${c.name}: serves the web shell body`, async () => {
    const res = await fetch(`http://127.0.0.1:${hub.port}/`)
    const body = await res.text()
    expect(body, `must serve the web shell body, got: ${body.slice(0, 200)}`).toContain(
      '<div id="root">'
    )
  })

  test(`${c.name}: /health reports authRequired:${c.authRequired}`, async () => {
    const res = await fetch(`http://127.0.0.1:${hub.port}/health`)
    const body = (await res.json()) as { authRequired?: unknown }
    // The exact bit the web shell's hub-health.ts reads to skip LoginScreen.
    expect(
      body.authRequired,
      `expected authRequired:${c.authRequired}, got ${JSON.stringify(body)}`
    ).toBe(c.authRequired)
  })
}
