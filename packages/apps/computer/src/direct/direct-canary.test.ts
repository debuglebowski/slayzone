/**
 * The direct-link canary (docs/direct-link.md), the computer's twin of the hub-disk
 * canary (`packages/apps/api/src/hub-disk-canary.test.ts`): a direct-link client must
 * not make the computer read, list or write a file by naming it. So this ENUMERATES
 * every procedure of the direct router as the computer's listener serves it (queries,
 * mutations and subscriptions), calls each through a real socket holding grants for
 * the ids it names, with every path-like field (then every string leaf) set to a
 * canary, and fails when a filesystem call that reads, lists or writes content
 * touches a canary. A direct procedure added tomorrow is in this test tomorrow.
 *
 * The canaries: a file outside every allowed root, a file inside one, and a folder.
 */
import type * as FsNs from 'node:fs'
import type * as FsPromisesNs from 'node:fs/promises'
import { afterAll, expect, test, vi } from 'vitest'
import {
  fillInput,
  maxUnion,
  watchFsModule,
  type FillMode
} from '../../../../shared/test-utils/canary-inputs'

const touches: Array<{ fn: string; arg: string; route: string }> = []
const state = { route: '', canaries: [] as string[] }
const isCanary = (a: unknown): string | null => {
  const s = typeof a === 'string' ? a : a instanceof URL ? a.pathname : null
  if (!s) return null
  return state.canaries.some((c) => s === c || s.startsWith(`${c}/`)) ? s : null
}
function watch<T extends object>(mod: T): T {
  return watchFsModule(mod, (fn, a) => {
    const hit = isCanary(a)
    if (hit && state.route) touches.push({ fn, arg: hit, route: state.route })
  })
}
vi.mock('node:fs', async (orig) => {
  const m = await orig<typeof FsNs>()
  const w = watch(m)
  return { ...w, default: w, promises: watch(m.promises) }
})
vi.mock('fs', async (orig) => {
  const m = await orig<typeof FsNs>()
  const w = watch(m)
  return { ...w, default: w, promises: watch(m.promises) }
})
vi.mock('node:fs/promises', async (orig) => {
  const w = watch(await orig<typeof FsPromisesNs>())
  return { ...w, default: w }
})
vi.mock('fs/promises', async (orig) => {
  const w = watch(await orig<typeof FsPromisesNs>())
  return { ...w, default: w }
})

const fs = await import('node:fs')
const { createHash } = await import('node:crypto')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { createTRPCClient, createWSClient, wsLink } = await import('@trpc/client')
const WebSocket = (await import('ws')).default
const { wireSuperjson } = await import('@slayzone/trpc-server/wire')
const { HubToComputerMethods } = await import('@slayzone/computer-transport/shared')
const { createDirectRouter } = await import('@slayzone/transport/direct')
const { startComputer } = await import('../main')

const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'slz-direct-canary-')))
const allowed = join(base, 'allowed')
const outside = join(base, 'outside')
for (const d of [allowed, outside, join(allowed, 'slz-canary-dir')])
  fs.mkdirSync(d, { recursive: true })
const outsideFile = join(outside, 'secret.txt')
const insideFile = join(allowed, 'slz-canary.txt')
fs.writeFileSync(outsideFile, 'CANARY')
fs.writeFileSync(insideFile, 'CANARY-IN')
const CANARIES: Array<[label: string, path: string]> = [
  ['a file outside every allowed root', outsideFile],
  ['a file inside an allowed root', insideFile],
  ['a folder inside an allowed root', join(allowed, 'slz-canary-dir')]
]

/** The ids the filled inputs name: one session and one chat tab, both granted. */
const SESSION = 'canary:session'
const TAB = 'canary-tab'
const idFor = (key: string): unknown => {
  if (/sessionId$/.test(key)) return SESSION
  if (/tabId$/.test(key)) return TAB
  return 'x'
}
const PATH_KEYS = ['path', 'paths', 'filePath', 'cwd', 'dirPath', 'sourcePath', 'rootPath']
const opaque = (canary: string) => {
  const o: Record<string, unknown> = { sessionId: SESSION, tabId: TAB }
  for (const k of PATH_KEYS) o[k] = /s$/.test(k) ? [canary] : canary
  return o
}
let mode: FillMode = { leaves: 'paths', union: 0 }
const fill = (schema: unknown, canary: string): unknown =>
  fillInput(schema, canary, mode, { idFor, opaque, pathKeys: PATH_KEYS })

// ── a real computer, its direct listener and a socket with grants ─────────────

let onHubRequest:
  | ((method: string, params: unknown, actor: unknown) => Promise<unknown>)
  | undefined
let identity: { directAddress?: () => string | null } | undefined
// The live session is a project's: it starts in that project's folder (§9 Phase 7c).
const { placeTestProject } = await import('../project-scope.fixture')
const slayRoot = fs.mkdtempSync(join(tmpdir(), 'slz-direct-canary-root-'))
placeTestProject(slayRoot, 'ws://localhost:0/computers', 'p1', allowed)
vi.stubEnv('SLAYZONE_ROOT', slayRoot)
const handle = startComputer(
  {
    hubUrl: 'ws://localhost:0/computers',
    name: 'canary',
    allowedRoots: [allowed],
    capabilities: ['pty', 'git', 'fs', 'proc']
  },
  {
    credentialStore: {
      load: async () => null,
      save: async () => {},
      clear: async () => {},
      filePath: '/dev/null'
    },
    stateDir: fs.mkdtempSync(join(tmpdir(), 'slz-direct-canary-state-')),
    createDialer: (options) => {
      identity = options.identity
      onHubRequest = options.onHubRequest as typeof onHubRequest
      return {
        events: { on: () => undefined },
        computerId: null,
        start: () => undefined,
        stop: async () => undefined,
        notify: () => true
      } as never
    }
  }
)
await vi.waitFor(() => expect(identity?.directAddress?.()).toBeTruthy(), { timeout: 10_000 })
const tokens = ['p'.repeat(43), 'c'.repeat(43)]
const ACTOR = { userId: null, route: 'canary' }
const resources = [
  { kind: 'pty' as const, sessionId: SESSION },
  { kind: 'chat' as const, tabId: TAB, epoch: 1 }
]
for (const [i, resource] of resources.entries()) {
  await onHubRequest?.(
    HubToComputerMethods.directGrant,
    {
      grantId: `canary-${i}`,
      tokenHash: createHash('sha256').update(tokens[i]!).digest('hex'),
      userId: null,
      resource,
      ttlMs: 600_000
    },
    ACTOR
  )
}
// A live session to read and type into.
await onHubRequest?.(
  HubToComputerMethods.ptySpawn,
  { sessionId: SESSION, projectId: 'p1', command: 'cat', cwd: allowed, relay: false },
  ACTOR
)
const ws = createWSClient({
  url: `ws://${identity?.directAddress?.()}/direct/v1`,
  WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
  connectionParams: { token: tokens[0] },
  retryDelayMs: () => 60_000
})
const client = createTRPCClient<import('@slayzone/transport/direct').DirectRouter>({
  links: [wsLink({ client: ws, transformer: wireSuperjson })]
})
await client.authorize.mutate({ token: tokens[1]! })
afterAll(async () => {
  ws.close()
  await handle.stop()
  fs.rmSync(base, { recursive: true, force: true })
})

type Proc = { _def: { type: string; inputs: unknown[] } }
const procedures = Object.entries(
  (
    createDirectRouter({ pty: () => null, chat: () => null }) as unknown as {
      _def: { procedures: Record<string, Proc> }
    }
  )._def.procedures
)
const at = (path: string) =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], client) as Record<
    string,
    (input: unknown, opts?: unknown) => unknown
  >
const withTimeout = (p: Promise<unknown>, ms = 3_000) =>
  Promise.race([p, new Promise((r) => setTimeout(r, ms))]).catch(() => undefined)

test(`direct link: no procedure lets a client touch a canary on the computer's disk (${procedures.length} procedures)`, async () => {
  expect(procedures.map(([p]) => p)).toEqual(
    expect.arrayContaining(['pty.attach', 'pty.write', 'pty.onData', 'chat.onEvent'])
  )
  // The socket really reaches the services (else every call would be refused early).
  expect(await client.pty.attach.query({ sessionId: SESSION, afterSeq: -1 })).toMatchObject({
    exists: true
  })
  touches.length = 0
  for (const [label, canary] of CANARIES) {
    state.canaries = [canary]
    for (const [path, proc] of procedures) {
      const schema = proc._def.inputs[0]
      for (const leaves of ['paths', 'all'] as const) {
        for (let union = 0; union < (schema ? maxUnion(schema) : 1); union++) {
          mode = { leaves, union }
          const input = schema ? fill(schema, canary) : undefined
          state.route = `direct ${path} (${label}; ${leaves}, union ${union})`
          const call = at(path)
          if (proc._def.type === 'subscription') {
            await withTimeout(
              new Promise<void>((resolve) => {
                const sub = (call.subscribe as (i: unknown, o: object) => { unsubscribe(): void })(
                  input,
                  { onError: () => resolve(), onComplete: () => resolve() }
                )
                setTimeout(() => {
                  sub.unsubscribe()
                  resolve()
                }, 150)
              })
            )
          } else {
            const fn = proc._def.type === 'query' ? call.query : call.mutate
            await withTimeout(Promise.resolve().then(() => fn?.(input)))
          }
          state.route = ''
        }
      }
    }
  }
  expect(touches, 'computer canaries touched through the direct link').toEqual([])
}, 300_000)
