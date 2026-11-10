/**
 * Web shell e2e (113–116): helpers shared by the specs that spawn a real hub and give
 * it one real computer. A task's or project's folder lives only on a computer (the
 * hub keeps no path, robustness plan §9 7e), so any spec that needs a folder — a
 * terminal to render, files to edit — attaches one.
 */
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import type { AnyTRPCRouter } from '@trpc/server'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const HUB_DIR = path.resolve(__dirname, '..', '..', '..', 'hub')

/** The hub a web shell spec spawned, as these helpers need it. */
export interface WebShellHub {
  base: string
  /** Temp dir holding the hub's state and its seeded folders, side by side. */
  scratch: string
  owner: { email: string; token: string } | null
}

export function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (/^(ELECTRON_|SLAYZONE_)/.test(k)) continue
    out[k] = v
  }
  return out
}

export async function until<T>(fn: () => Promise<T | null> | T | null, label: string): Promise<T> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const v = await fn()
      if (v != null) return v
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const COMPUTER_BIN = path.resolve(HUB_DIR, '..', 'computer', 'dist', 'bin.cjs')

/**
 * A real computer, jailed to the hub's scratch dir. Project files are read and written
 * only on a computer, never by the hub itself, so the editor needs one to read
 * anything at all. Without login it is the hub's sole (default) computer; with login
 * it is enrolled for the owner, since file work runs only on its owner's computers
 * (computer-placement.ts).
 */
export async function attachComputer(
  hub: WebShellHub,
  name = 'e2e-web-shell-computer'
): Promise<() => Promise<void>> {
  const { createTRPCClient, createWSClient, wsLink } = await import('@trpc/client')
  const superjson = (await import('superjson')).default
  const owner = hub.owner
  /** The two hub procedures this helper calls. */
  interface OwnerClient {
    computers: {
      mintJoinToken: { mutate: (i: { label: string; forUser?: string }) => Promise<unknown> }
      list: { query: () => Promise<unknown> }
    }
  }
  const withClient = async <T>(fn: (c: OwnerClient) => Promise<T>): Promise<T> => {
    const ws = createWSClient({
      url: `${hub.base.replace(/^http/, 'ws')}/trpc`,
      connectionParams: async () => (owner ? { token: owner.token } : {})
    })
    try {
      return await fn(
        createTRPCClient<AnyTRPCRouter>({
          links: [wsLink({ client: ws, transformer: superjson })]
        }) as unknown as OwnerClient
      )
    } finally {
      ws.close()
    }
  }
  const minted = (await withClient((c) =>
    c.computers.mintJoinToken.mutate(
      owner ? { label: name, forUser: owner.email } : { label: name }
    )
  )) as { token: string }
  const rootDir = path.join(hub.scratch, 'computer-root')
  fs.mkdirSync(rootDir, { recursive: true })
  fs.writeFileSync(
    path.join(rootDir, 'computer.config.json'),
    JSON.stringify({ computerName: name, allowedRoots: [hub.scratch] })
  )
  const proc: ChildProcess = spawn(require('electron') as unknown as string, [COMPUTER_BIN], {
    env: {
      ...scrubbedEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      SLAYZONE_ROOT: rootDir,
      SLAYZONE_HUB_ADDRESS: new URL(hub.base).host,
      SLAYZONE_HUB_JOIN_TOKEN: minted.token,
      SLAYZONE_COMPUTER_CREDENTIALS_DIR: path.join(hub.scratch, 'computer-creds')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  proc.stdout?.on('data', () => undefined)
  proc.stderr?.on('data', () => undefined)
  await until(async () => {
    const rows = (await withClient((c) => c.computers.list.query())) as Array<{
      name: string
      usable: boolean
    }>
    return rows.some((r) => r.usable && r.name === name) ? true : null
  }, 'owner computer usable')
  return () =>
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
