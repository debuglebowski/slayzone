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
 * The state a user can plant (round-9 Q3, so Q1 shows here): B's own REMOTE computer
 * reports project folders at every canary and at `/`, and B's tasks there have
 * worktrees at them — what any user's computer can claim. A's folders are recorded the
 * ways the hub's disk records them: a legacy project path and a hub-side worktree.
 * Inputs: every path-like field, then every string leaf, each for every union option.
 * REST also gets a multipart and a raw-body request; every fs argument is checked.
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
const touches: Array<{ fn: string; arg: string; route: string; stack: string }> = []
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
      for (const a of args) {
        const hit = isCanary(a)
        if (hit && state.route)
          touches.push({
            fn: name,
            arg: hit,
            route: state.route,
            // Where the read came from: a call that got past the gate earlier and
            // changed what B owns shows up under a later route's name otherwise.
            stack: (new Error().stack ?? '')
              .split('\n')
              .filter((l) => l.includes('/src/') && !l.includes('hub-disk-canary'))
              .slice(0, 6)
              .join(' | ')
          })
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
const { setHubDiskComputer } = await import('./access')
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
// A's folders as the hub's disk records them: the legacy project path above, and a
// hub-side worktree (a task on the hub's own local computer, the desktop's). A task on
// no computer is NOT one: B removing B's own computer clears its tasks' computer —
// this test found that laundering B's planted worktrees into "hub-side" ones (Q1).
fs.mkdirSync(join(aRoot, 'wt'), { recursive: true })
sql(
  `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at, owner_user_id)
   VALUES ('cLocal', 'local', 'darwin', '1', '[]', 1, ?)`,
  A
)
setHubDiskComputer('cLocal')
sql(
  `INSERT INTO tasks (id, project_id, title, worktree_path, computer_id) VALUES ('tA2', 'pA', 'a2', ?, 'cLocal')`,
  join(aRoot, 'wt')
)
// What B can plant: B's own remote computer reporting project folders at every canary
// and at `/`, with B's tasks' worktrees there.
sql(
  `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at, owner_user_id)
   VALUES ('cB', 'b', 'linux-x64', '1', '[]', 1, ?), ('cA', 'a', 'linux-x64', '1', '[]', 1, ?)`,
  B,
  A
)
const planted = [
  nobodys,
  aRoot,
  join(aRoot, 'slz-canary-dir'),
  join(aRoot, 'slz-canary-a.txt'),
  looseFile,
  '/'
]
planted.forEach((folder, i) => {
  sql(
    `INSERT INTO projects (id, name, color, owner_user_id) VALUES (?, 'B planted', '#222', ?)`,
    `pBp${i}`,
    B
  )
  sql(
    `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
     VALUES ('cB', ?, ?, 'ready', 1)`,
    `pBp${i}`,
    folder
  )
  sql(
    `INSERT INTO tasks (id, project_id, title, worktree_path, computer_id) VALUES (?, ?, 'p', ?, 'cB')`,
    `tBp${i}`,
    `pBp${i}`,
    folder
  )
})
// A's computer reporting A's own folder too (a tie B must not break by naming cB).
sql(
  `INSERT INTO project_placements (computer_id, project_id, root_path, status, updated_at)
   VALUES ('cA', 'pA', ?, 'ready', 1)`,
  aRoot
)

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
  if (/computerId$|^computer_id$/.test(key)) return 'cB'
  if (key === 'id') return ownIdFor(state.route)
  return 'x'
}
/**
 * A bare `id`: B's own resource of the kind the route is about, so a call that edits
 * one (projects.update) really runs — round 10: with `id: 'x'` the canary could not
 * see projects.update write the legacy project path.
 */
function ownIdFor(route: string): string {
  if (/project/i.test(route)) return 'pB'
  if (/computer/i.test(route)) return 'cB'
  if (/task/i.test(route)) return 'tB'
  return 'x'
}
/** An id field: kept B's own in every mode, so id checks let the call through. */
const isIdKey = (k: string): boolean => /(^id$|Id$|_id$|Ids$)/.test(k)

type Def = { type: string; [k: string]: unknown }
const defOf = (s: unknown): Def | null =>
  ((s as { _zod?: { def?: Def } })?._zod?.def ?? null) as Def | null

function opaque(canary: string): Record<string, unknown> {
  const o: Record<string, unknown> = {
    taskId: 'tB',
    projectId: 'pB',
    computerId: 'cB',
    target: { computerId: 'cB' },
    title: 'x',
    id: ownIdFor(state.route)
  }
  for (const k of PATH_KEYS) o[k] = /s$/.test(k) ? [canary] : canary
  return o
}

/** Which leaves get the canary, and which option of every union is taken. */
interface FillMode {
  /** `paths`: path-like fields only; `all`: every string leaf but ids. */
  readonly leaves: 'paths' | 'all'
  readonly union: number
}
let mode: FillMode = { leaves: 'paths', union: 0 }

/** Most options any union in `schema` has (each one is tried). */
function maxUnion(schema: unknown, depth = 0): number {
  const def = defOf(schema)
  if (!def || depth > 8) return 1
  const kids: unknown[] = []
  if (def.type === 'object') kids.push(...Object.values(def.shape as Record<string, unknown>))
  for (const k of ['innerType', 'in', 'element', 'left', 'right'] as const)
    if (def[k]) kids.push(def[k])
  if (def.type === 'tuple') kids.push(...(def.items as unknown[]))
  let n = def.type === 'union' ? (def.options as unknown[]).length : 1
  if (def.type === 'union') kids.push(...(def.options as unknown[]))
  for (const k of kids) n = Math.max(n, maxUnion(k, depth + 1))
  return Math.min(n, 6)
}

/** A value for `schema` with every path-like field (or string leaf) set to `canary`. */
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
    case 'union': {
      const options = def.options as unknown[]
      return fill(options[mode.union % options.length], canary, key, depth + 1)
    }
    case 'intersection':
      return {
        ...(fill(def.left, canary, key, depth + 1) as object),
        ...(fill(def.right, canary, key, depth + 1) as object)
      }
    case 'string':
      if (isPathKey(key)) return canary
      return mode.leaves === 'all' && !isIdKey(key) ? canary : idFor(key)
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
      return Object.fromEntries(PATH_KEYS.map((k) => [k, canary]))
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
      const schema = proc._def.inputs[0]
      for (const leaves of ['paths', 'all'] as const) {
        for (let union = 0; union < (schema ? maxUnion(schema) : 1); union++) {
          mode = { leaves, union }
          const input = schema ? fill(schema, canary) : undefined
          state.route = `trpc ${path} (${label}; ${leaves}, union ${union})`
          await withTimeout(Promise.resolve().then(() => at(path)(input)))
          state.route = ''
        }
      }
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
      const q = new URLSearchParams(
        Object.entries(opaque(canary)).map(([k, v]) => [k, String(Array.isArray(v) ? v[0] : v)])
      )
      // JSON, multipart (fields + a file part named like a path) and a raw body.
      const bodies: Array<[string, () => RequestInit]> = [
        [
          'json',
          () => ({
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(opaque(canary))
          })
        ],
        [
          'multipart',
          () => {
            const form = new FormData()
            for (const [k, v] of Object.entries(opaque(canary)))
              form.append(k, typeof v === 'string' ? v : JSON.stringify(v))
            form.append('file', new Blob(['x']), canary)
            return { body: form }
          }
        ],
        ['raw', () => ({ headers: { 'content-type': 'application/octet-stream' }, body: canary })]
      ]
      for (const [kind, init] of r.method === 'get' ? bodies.slice(0, 1) : bodies) {
        state.route = `${restRouteKey(r.method, r.path)} (${label}; ${kind})`
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), 3_000)
        const req = init()
        await fetch(`http://127.0.0.1:${port}${url}?${q}`, {
          method: r.method.toUpperCase(),
          ...(r.method === 'get' ? {} : req),
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
