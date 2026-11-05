/**
 * Round-8 P1: on a hub with login, NO caller-named path may make the hub read or write
 * a file on its own disk that the caller may not access. `artifacts.create` took a
 * `sourcePath` its policy never checked and read any hub file (the hub database via
 * `/dev/fd/<n>`); N1 had sealed only the routes it listed. So this does not list
 * routes: it ENUMERATES them — every tRPC procedure from `appRouter`, every REST route
 * and MCP tool as registered — calls each as user B with every path-like field it takes
 * (from its zod input; an unvalidated input gets every path key there is) set to a
 * canary on the hub's disk, and fails when any filesystem call that reads, lists or
 * writes a file touches a canary. A route added tomorrow is in this test tomorrow.
 *
 * The canaries: a file in nobody's folder, a folder of user A's (B must never list it),
 * the same file through `/dev/fd/<n>` (realpath names nothing real there), and A's file.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/apps/api/src/hub-disk-canary.test.ts
 */
import type * as FsNs from 'node:fs'
import type * as FsPromisesNs from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, test, vi } from 'vitest'

// ── fs, watched ───────────────────────────────────────────────────────────────

/** fs functions that read, list or write CONTENT. stat/exists/realpath decide access
 *  (access.ts) and read nothing, so they are not touches. */
const CONTENT_FNS = new Set([
  'readFile',
  'readFileSync',
  'createReadStream',
  'createWriteStream',
  'open',
  'openSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'rename',
  'renameSync',
  'unlink',
  'unlinkSync',
  'rm',
  'rmSync',
  'readdir',
  'readdirSync',
  'opendir',
  'opendirSync',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync'
])
const touches: Array<{ fn: string; arg: string; route: string }> = []
const state = { route: '', canaries: [] as string[] }
const isCanary = (a: unknown): string | null => {
  const s = typeof a === 'string' ? a : a instanceof URL ? a.pathname : null
  if (!s) return null
  return state.canaries.some((c) => s === c || s.startsWith(`${c}/`)) ? s : null
}
function watch<T extends object>(mod: T): T {
  const out: Record<string, unknown> = { ...(mod as Record<string, unknown>) }
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn !== 'function' || !CONTENT_FNS.has(name)) continue
    out[name] = (...args: unknown[]) => {
      for (const a of args.slice(0, 2)) {
        const hit = isCanary(a)
        if (hit && state.route) touches.push({ fn: name, arg: hit, route: state.route })
      }
      return (fn as (...a: unknown[]) => unknown).apply(mod, args)
    }
  }
  return out as T
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

// ── the hub ───────────────────────────────────────────────────────────────────

const fs = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const express = (await import('express')).default
const { setSecurityLogSink } = await import('@slayzone/platform/security-log')
const { setAuthGate } = await import('@slayzone/trpc-server')
const { setHostCapabilitiesDeps } = await import('@slayzone/host-capabilities/server')
const { createTestHarness } = await import('../../../shared/test-utils/ipc-harness.js')
const { appRouter } = await import('./router')
const { registerRestApi } = await import('./http/rest-api')
const { restRouteKey } = await import('./http/rest-api/admin-routes')
const { bindRestPrincipal } = await import('./http/rest-api/principal')
const { registerMcpTools } = await import('./http/mcp-tools')
const { mcpAuthInfo } = await import('./http/mcp-tools/admin-gate')

const h = await createTestHarness()
const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)
setSecurityLogSink(() => undefined)
setAuthGate(() => true)
// The host seam, inert: nothing here may open a window, a browser or Finder.
setHostCapabilitiesDeps({
  getHost: () =>
    new Proxy(
      {},
      { get: () => async () => undefined }
    ) as unknown as import('@slayzone/host-capabilities/server').HostCapabilities
})

const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'slz-hubdisk-')))
const hubRoot = join(base, 'hub-root')
const aRoot = join(base, 'a-proj')
const bRoot = join(base, 'b-proj')
const nobodys = join(base, 'slz-canary-nobodys')
for (const d of [hubRoot, aRoot, bRoot, nobodys, join(aRoot, 'slz-canary-dir')]) {
  fs.mkdirSync(d, { recursive: true })
}
const looseFile = join(nobodys, 'secret.txt')
const aFile = join(aRoot, 'slz-canary-a.txt')
fs.writeFileSync(looseFile, 'CANARY')
fs.writeFileSync(aFile, 'CANARY-A')
fs.writeFileSync(join(bRoot, 'own.txt'), 'B-OWN')
const fd = fs.openSync(looseFile, 'r')
const devFd = `/dev/fd/${fd}`
process.env.SLAYZONE_ROOT = hubRoot

const A = 'user-a'
const B = 'user-b'
sql(
  `INSERT INTO projects (id, name, color, owner_user_id, path) VALUES
   ('pA', 'A', '#111', ?, ?), ('pB', 'B', '#222', ?, ?)`,
  A,
  aRoot,
  B,
  bRoot
)
sql(`INSERT INTO tasks (id, project_id, title) VALUES ('tA', 'pA', 'a'), ('tB', 'pB', 'b')`)

/** Each canary, with the extra paths its touches may take (a folder's entries). */
const CANARIES: Array<[label: string, path: string]> = [
  ["a file in nobody's folder", looseFile],
  ["A's file", aFile],
  ["A's folder", join(aRoot, 'slz-canary-dir')],
  ['/dev/fd/<n> of a canary', devFd]
]

// ── inputs ────────────────────────────────────────────────────────────────────

/** Every field name a path travels under, for inputs with no schema. */
const PATH_KEYS = [
  'path',
  'paths',
  'sourcePath',
  'sourcePaths',
  'filePath',
  'filePaths',
  'dirPath',
  'absPath',
  'outputPath',
  'rootPath',
  'projectPath',
  'repoPath',
  'worktreePath',
  'targetPath',
  'baseDir',
  'cwd',
  'iconImagePath',
  'imagePath',
  'worktree_path',
  'base_dir',
  'icon_image_path',
  'source_path',
  'file_path'
]
const isPathKey = (k: string): boolean =>
  /(^path$|^paths$|Paths?$|Dir$|^cwd$|_path$|_dir$|^dir$)/.test(k) && !/Id$/.test(k)

/** A value for a field that is not a path: B's own ids, so id checks let it through. */
function idFor(key: string): unknown {
  if (/taskId$|^task_id$/.test(key)) return 'tB'
  if (/projectId$|^project_id$/.test(key)) return 'pB'
  return 'x'
}

type Def = { type: string; [k: string]: unknown }
const defOf = (s: unknown): Def | null =>
  ((s as { _zod?: { def?: Def } })?._zod?.def ?? null) as Def | null

function opaque(canary: string): Record<string, unknown> {
  const o: Record<string, unknown> = { taskId: 'tB', projectId: 'pB', title: 'x', id: 'x' }
  for (const k of PATH_KEYS) o[k] = /s$/.test(k) ? [canary] : canary
  return o
}

/** A value for `schema` with every path-like field set to `canary`. */
function fill(schema: unknown, canary: string, key = '', depth = 0): unknown {
  const def = defOf(schema)
  if (!def || depth > 8) return opaque(canary)
  switch (def.type) {
    case 'object': {
      const shape = def.shape as Record<string, unknown>
      const o: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(shape)) o[k] = fill(v, canary, k, depth + 1)
      return o
    }
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'nonoptional':
    case 'catch':
      return fill(def.innerType, canary, key, depth + 1)
    case 'pipe':
      return fill(def.in, canary, key, depth + 1)
    case 'lazy':
      return fill((def.getter as () => unknown)(), canary, key, depth + 1)
    case 'array':
      return [fill(def.element, canary, key, depth + 1)]
    case 'tuple':
      return (def.items as unknown[]).map((i) => fill(i, canary, key, depth + 1))
    case 'union':
      return fill((def.options as unknown[])[0], canary, key, depth + 1)
    case 'intersection':
      return {
        ...(fill(def.left, canary, key, depth + 1) as object),
        ...(fill(def.right, canary, key, depth + 1) as object)
      }
    case 'string':
      return isPathKey(key) ? canary : idFor(key)
    case 'number':
    case 'int':
      return 0
    case 'boolean':
      return false
    case 'enum':
      return Object.values(def.entries as Record<string, unknown>)[0]
    case 'literal':
      return (def.values as unknown[])[0]
    case 'record':
      return {}
    case 'null':
      return null
    default:
      // unknown / any / custom: it takes anything — so every path key there is.
      return opaque(canary)
  }
}

const withTimeout = (p: Promise<unknown>, ms = 3_000) =>
  Promise.race([p, new Promise((r) => setTimeout(r, ms))]).catch(() => undefined)

// ── tRPC ──────────────────────────────────────────────────────────────────────

type Proc = { _def: { type: string; inputs: unknown[] } }
const procedures = Object.entries(
  (appRouter as unknown as { _def: { procedures: Record<string, Proc> } })._def.procedures
).filter(([, p]) => p._def.type !== 'subscription')

const callerB = appRouter.createCaller({
  db: h.slayDb,
  dataRoot: hubRoot,
  principal: { userId: B, role: 'user' as const, scopes: ['full' as const] }
})
const at = (path: string) =>
  path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], callerB) as (
    input: unknown
  ) => Promise<unknown>

test(`tRPC: no procedure lets user B touch a canary on the hub's disk (${procedures.length} procedures)`, async () => {
  touches.length = 0
  expect(procedures.length).toBeGreaterThan(300)
  for (const [label, canary] of CANARIES) {
    state.canaries = [canary]
    for (const [path, proc] of procedures) {
      const input = proc._def.inputs.length ? fill(proc._def.inputs[0], canary) : undefined
      state.route = `trpc ${path} (${label})`
      await withTimeout(Promise.resolve().then(() => at(path)(input)))
      state.route = ''
    }
  }
  expect(touches, 'hub-disk canaries touched').toEqual([])
}, 600_000)

// ── REST ──────────────────────────────────────────────────────────────────────

const routes: Array<{ method: string; path: string }> = []
const app = express()
app.use(express.json({ limit: '1mb' }))
app.use((req, _res, next) => {
  bindRestPrincipal(req, { userId: B, role: 'user', scopes: ['full'] } as never)
  next()
})
const recording = new Proxy(app, {
  get(target, prop, receiver) {
    const v = Reflect.get(target, prop, receiver)
    if (typeof prop === 'string' && ['get', 'post', 'put', 'patch', 'delete'].includes(prop)) {
      return (path: string, ...rest: unknown[]) => {
        if (typeof path === 'string') routes.push({ method: prop, path })
        return (v as (...a: unknown[]) => unknown).call(target, path, ...rest)
      }
    }
    return typeof v === 'function' ? v.bind(target) : v
  }
})
registerRestApi(recording as never, { db: h.slayDb, notifyRenderer: () => {} })
const server = app.listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const port = (server.address() as AddressInfo).port
afterAll(() => {
  server.close()
  fs.closeSync(fd)
  h.cleanup()
})

test(`REST: no route lets user B touch a canary on the hub's disk (${routes.length} routes)`, async () => {
  touches.length = 0
  expect(routes.length).toBeGreaterThan(50)
  for (const [label, canary] of CANARIES) {
    state.canaries = [canary]
    for (const r of routes) {
      const url = r.path.replace(/:(\w+)/g, (_m, k: string) =>
        String(idFor(k) === 'x' ? 'tB' : idFor(k))
      )
      const q = new URLSearchParams({ path: canary, filePath: canary, dirPath: canary })
      state.route = `${restRouteKey(r.method, r.path)} (${label})`
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 3_000)
      await fetch(`http://127.0.0.1:${port}${url}?${q}`, {
        method: r.method.toUpperCase(),
        headers: { 'content-type': 'application/json' },
        body: r.method === 'get' ? undefined : JSON.stringify(opaque(canary)),
        signal: ac.signal
      })
        .then((res) => res.arrayBuffer())
        .catch(() => undefined)
      clearTimeout(timer)
      // A route may finish its work after it answered.
      await new Promise((res) => setTimeout(res, 5))
      state.route = ''
    }
  }
  expect(touches, 'hub-disk canaries touched').toEqual([])
}, 600_000)

// ── MCP ───────────────────────────────────────────────────────────────────────

const tools = new Map<string, (...a: unknown[]) => unknown>()
registerMcpTools(
  {
    tool: (name: string, ...rest: unknown[]) => {
      tools.set(name, rest[rest.length - 1] as (...a: unknown[]) => unknown)
    }
  } as never,
  { db: h.slayDb, notifyRenderer: () => {} }
)

test(`MCP: no tool lets user B touch a canary on the hub's disk (${tools.size} tools)`, async () => {
  touches.length = 0
  expect(tools.size).toBeGreaterThan(3)
  const extra = { authInfo: mcpAuthInfo({ userId: B, role: 'user', scopes: ['full'] } as never) }
  for (const [label, canary] of CANARIES) {
    state.canaries = [canary]
    for (const [name, handler] of tools) {
      state.route = `mcp ${name} (${label})`
      await withTimeout(Promise.resolve().then(() => handler(opaque(canary), extra)))
      state.route = ''
    }
  }
  expect(touches, 'hub-disk canaries touched').toEqual([])
}, 600_000)
