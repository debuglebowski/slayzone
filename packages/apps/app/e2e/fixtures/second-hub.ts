/**
 * A second, standalone hub for e2e specs that need a REMOTE hub beside the app's own:
 * the hub bin run unsupervised on its own loopback port and store, with login on and
 * its bootstrap owner as the caller's credential. Plus the two things a spec does with
 * it: a raw tRPC client, and handing the running app a bearer for it.
 *
 * `112-multi-hub-federation.spec.ts` carries its own copies of these (older, and with
 * more helpers around them); this module is what new specs import.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import type { AnyTRPCRouter } from '@trpc/server'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
export const APP_DIR = path.resolve(__dirname, '..', '..')
const HUB_BIN = path.resolve(APP_DIR, '..', 'hub', 'dist', 'bin.cjs')

export interface SecondHub {
  proc: ChildProcess
  port: number
  /** Its client url, `ws://127.0.0.1:<port>/trpc`. */
  url: string
  /** Bootstrap-owner bearer (an admin). */
  token: string
  email: string
  stop: () => Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function readOwner(
  hubRoot: string,
  timeoutMs = 30_000
): Promise<{ token: string; email: string }> {
  const file = path.join(hubRoot, 'hub.owner.json')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: string; email?: string }
      if (parsed.token && parsed.email) return { token: parsed.token, email: parsed.email }
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`hub owner file not usable within ${timeoutMs}ms: ${file}`)
}

/** Spawn a standalone hub on a free loopback port, state under `<storeDir>/hub`. */
export async function spawnSecondHub(storeDir: string): Promise<SecondHub> {
  if (!fs.existsSync(HUB_BIN)) throw new Error(`hub bin missing: ${HUB_BIN} (run pnpm build)`)
  const hubRoot = path.join(storeDir, 'hub')
  fs.mkdirSync(hubRoot, { recursive: true })
  const port = await freePort()
  const electronPath = require('electron') as unknown as string
  // Strip inherited SLAYZONE_*/ELECTRON_*: run from a SlayZone terminal, the parent's
  // SLAYZONE_ROOT would point this hub at the real dev install.
  const cleanEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null || /^(ELECTRON_|SLAYZONE_)/.test(k)) continue
    cleanEnv[k] = v
  }
  const proc = spawn(electronPath, [HUB_BIN], {
    env: {
      ...cleanEnv,
      ELECTRON_RUN_AS_NODE: '1',
      SLAYZONE_HUB_LISTEN_ADDRESS: `127.0.0.1:${port}`,
      SLAYZONE_HUB_REQUIRE_LOGIN: '1',
      SLAYZONE_ROOT: hubRoot
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  proc.stdout?.on('data', () => undefined)
  proc.stderr?.on('data', () => undefined)
  const owner = await readOwner(hubRoot)
  return {
    proc,
    port,
    url: `ws://127.0.0.1:${port}/trpc`,
    token: owner.token,
    email: owner.email,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
        const t = setTimeout(() => proc.kill('SIGKILL'), 3_000)
        proc.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
        proc.kill('SIGTERM')
      })
  }
}

/** Poll GET /health until the hub answers `{ ok: true }`. */
export async function waitForHubHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok && ((await res.json()) as { ok?: boolean }).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`second hub /health not ready on :${port} within ${timeoutMs}ms`)
}

/** Untyped proxy over a hub's appRouter, for the few procedures a spec calls. */
export type HubClient = Record<
  string,
  Record<
    string,
    { query: (input?: unknown) => Promise<unknown>; mutate: (input?: unknown) => Promise<unknown> }
  >
>

/** Run `fn` with a raw tRPC ws client to `hub`, as its owner, closing it after. */
export async function withHubClient<T>(
  hub: SecondHub,
  fn: (client: HubClient) => Promise<T>
): Promise<T> {
  const { createTRPCClient, createWSClient, wsLink } = await import('@trpc/client')
  const superjson = (await import('superjson')).default
  const ws = createWSClient({ url: hub.url, connectionParams: async () => ({ token: hub.token }) })
  const client = createTRPCClient<AnyTRPCRouter>({
    links: [wsLink({ client: ws, transformer: superjson })]
  }) as unknown as HubClient
  try {
    return await fn(client)
  } finally {
    ws.close()
  }
}

/**
 * Give the running app a bearer for a remote hub, the way a Settings sign-in does
 * (`app:set-hub-token` → safeStorage), then reload so the renderer's per-hub client
 * reconnects with it.
 */
export async function authorizeHubInApp(page: Page, hubId: string, token: string): Promise<void> {
  const ok = await page.evaluate(
    async ({ hubId, token }) => {
      const api = (
        window as unknown as {
          api: {
            app: {
              setHubToken: (p: { hubId: string; token: string }) => Promise<unknown>
              getHubTokens: () => Promise<Record<string, string>>
            }
          }
        }
      ).api
      await api.app.setHubToken({ hubId, token })
      return (await api.app.getHubTokens())[hubId] === token
    },
    { hubId, token }
  )
  if (!ok) throw new Error(`could not store hub token for ${hubId}`)
  await page.reload()
  await page.waitForSelector('#root', { timeout: 30_000 })
}
