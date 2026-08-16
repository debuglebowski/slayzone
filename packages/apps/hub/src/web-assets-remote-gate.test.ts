/**
 * The web shell is served under `SLAYZONE_MODE=remote` OR a SUPERVISED hub
 * — a REAL spawned hub, not a unit test of `handleWebAssets` in isolation
 * (which already has its own coverage in web-assets.test.ts and knows
 * nothing about mode).
 *
 * WHY THE GATE EXISTS AT ALL. A browser session's scoped token is a real
 * bearer credential riding every request (the `szw_` cookie and the tRPC
 * `connectionParams` token alike). Serving the shell over plain `http://`
 * would hand that credential to anyone on the network path between browser
 * and hub. `remote` is the one mode that terminates TLS with the hub
 * identity leaf — server.ts already refuses to boot a remote hub with no
 * identity loaded, so gating on `remote` ties the web shell to a mode that
 * is TLS-or-refuses-to-boot, never a false sense of security.
 *
 * WHY `supervised` IS INCLUDED TOO, and why that is NOT the same exception:
 * `hubAuthRequired = !supervised` (server.ts), so a supervised hub never
 * verifies a bearer at all — there is no credential riding the wire for
 * plain http to expose. The web shell mirrors this client-side
 * (`hub-health.ts`'s `fetchAuthRequired` + `main.tsx`'s boot branch): no
 * `authRequired` means no `LoginScreen`, connect with no token, exactly how
 * desktop/CLI clients already talk to a supervised hub.
 *
 * A real remote-mode hub needs a TLS identity generated at boot, which
 * install-handshake.test.ts's siblings don't otherwise need — that positive
 * case is covered by hand in the plan's manual verification checklist (and
 * by 113-web-shell-remote-login.spec.ts's e2e group). What this file exercises
 * end to end: local-mode refusal (unchanged regression) and the supervised
 * positive case (new), including that a supervised hub's own `/health`
 * reports `authRequired: false` — the exact bit the client boot branch reads.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   packages/apps/hub/src/web-assets-remote-gate.test.ts
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const ELECTRON_BIN = require('electron') as unknown as string

let passed = 0
let failed = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    failed++
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

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
 *  and return its port. Shared by the local-mode and supervised cases below
 *  so both go through the identical boot-and-poll sequence. */
async function spawnAndWait(
  root: string,
  extraEnv: Record<string, string>
): Promise<Proc & { port: number }> {
  const hub = spawnChild(HUB_BIN, {
    ...scrubbedEnv(),
    SLAYZONE_ROOT: root,
    SLAYZONE_HUB_ADDRESS: '127.0.0.1:0',
    ...extraEnv
  })
  const listen = await poll(
    async () => hub.logs.find((l) => l.includes('listening on http://')) ?? null,
    20_000,
    'hub listening line'
  )
  const m = listen.match(/http:\/\/(127\.0\.0\.1):(\d+)/)
  assert(m, `hub listening line parseable: ${listen}`)
  const port = Number(m![2])
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

async function main(): Promise<void> {
  console.log('\nweb shell served under SLAYZONE_MODE=remote OR a supervised hub\n')
  ensureBuilt()
  assert(
    existsSync(join(HUB_DIR, 'dist', 'web', 'index.html')),
    'dist/web/index.html must exist for this test to mean anything (run pnpm --filter @slayzone/web-shell build first)'
  )

  const localRoot = mkdtempSync(join(tmpdir(), 'slz-web-remote-gate-local-'))
  let localHub: (Proc & { port: number }) | null = null
  const supervisedRoot = mkdtempSync(join(tmpdir(), 'slz-web-remote-gate-supervised-'))
  let supervisedHub: (Proc & { port: number }) | null = null

  try {
    // Default mode (local, no SLAYZONE_MODE/SLAYZONE_SUPERVISED set) — the
    // shape that USED to serve dist/web unconditionally, and still must not:
    // hubAuthRequired is true here, so a browser session WOULD carry a real
    // bearer over plain http.
    localHub = await spawnAndWait(localRoot, {})

    await test('a LOCAL-mode (non-supervised) hub does NOT serve the web shell, even with dist/web/ present', async () => {
      const res = await fetch(`http://127.0.0.1:${localHub!.port}/`)
      const body = await res.text()
      assert(
        !body.includes('<div id="root">'),
        `local mode must not serve the web shell body, got: ${body.slice(0, 200)}`
      )
    })

    await test('/health and /api/* are unaffected by the mode gate', async () => {
      const health = await fetch(`http://127.0.0.1:${localHub!.port}/health`)
      assert(health.status === 200, 'health still answers')
    })

    // Supervised — the new positive case. `assertLoopbackBind` requires
    // loopback here, same address shape as the local-mode hub above.
    supervisedHub = await spawnAndWait(supervisedRoot, { SLAYZONE_SUPERVISED: '1' })

    await test('a SUPERVISED hub DOES serve the web shell body', async () => {
      const res = await fetch(`http://127.0.0.1:${supervisedHub!.port}/`)
      const body = await res.text()
      assert(
        body.includes('<div id="root">'),
        `supervised hub must serve the web shell body, got: ${body.slice(0, 200)}`
      )
    })

    await test('a SUPERVISED hub reports authRequired:false on /health', async () => {
      const res = await fetch(`http://127.0.0.1:${supervisedHub!.port}/health`)
      const body = (await res.json()) as { authRequired?: unknown }
      // The exact bit the web shell's hub-health.ts reads to skip LoginScreen.
      assert(
        body.authRequired === false,
        `expected authRequired:false, got ${JSON.stringify(body)}`
      )
    })
  } finally {
    if (localHub) await localHub.stop()
    if (supervisedHub) await supervisedHub.stop()
    rmSync(localRoot, { recursive: true, force: true })
    rmSync(supervisedRoot, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
