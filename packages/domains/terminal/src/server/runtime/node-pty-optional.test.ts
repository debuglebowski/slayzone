/**
 * node-pty is OPTIONAL in the published hub (T-30): importing the pty runtime must not
 * load it, a hub with processes off must never load it, and with processes on a missing
 * node-pty is a clear refusal at the spawn — never a crash at import. Once it is there,
 * the next spawn loads it (a failure is not cached).
 *
 * node-pty is "missing" through a Module._resolveFilename hook installed BEFORE the
 * runtime is imported, which also counts every attempt to resolve it.
 */
import { afterAll, expect, test } from 'vitest'
import Module from 'node:module'
import type { SlayzoneDb } from '@slayzone/platform'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import type { PtySessionWindow } from '../pty-host'

async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn()
    return null
  } catch (e) {
    return e
  }
}

// --- node-pty "not installed" --------------------------------------------------------
type Resolve = (request: string, ...rest: unknown[]) => string
const loader = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown> }
/** node-pty files loaded by any route — an ESM `import` resolves without the hook. */
const nodePtyLoaded = (): boolean =>
  Object.keys(loader._cache).some((k) => k.includes('/node-pty/'))
const realResolve = loader._resolveFilename
let blocked = true
let attempts = 0
loader._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
  if (request === 'node-pty') {
    attempts++
    if (blocked) {
      throw Object.assign(new Error(`Cannot find module '${request}'`), {
        code: 'MODULE_NOT_FOUND'
      })
    }
  }
  return realResolve.call(this, request, ...rest)
}

setSecurityLogSink(() => undefined)
const { localPtyBackend, spawnLocalPty, setPtyBackend, NodePtyUnavailableError } = await import(
  './pty-backend'
)
const { createPty, setDatabase } = await import('./pty-manager')

const spec = {
  sessionId: 's1:s1',
  taskId: 's1',
  computerId: null,
  projectId: null,
  file: '/bin/sh',
  args: [],
  options: { cwd: '/tmp', env: {}, cols: 80, rows: 24, name: 'xterm' },
  transport: false
}

test('importing the pty runtime does not load node-pty', () => {
  expect(attempts, `node-pty resolved ${attempts}x at import`).toBe(0)
  expect(nodePtyLoaded(), 'node-pty is in the module cache after import').toBeFalsy()
})

test('processes off: switch refusal, node-pty never loaded', async () => {
  process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
  try {
    const err = await caught(() => localPtyBackend.spawn(spec))
    expect(isHubSwitchedOffError(err), `expected the switch refusal, got ${err}`).toBeTruthy()
    expect(attempts, `node-pty resolved ${attempts}x`).toBe(0)
    expect(nodePtyLoaded(), `node-pty resolved ${attempts}x`).toBeFalsy()
  } finally {
    delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
  }
})

test('processes on, node-pty missing: clear refusal at the spawn', async () => {
  const err = await caught(() => localPtyBackend.spawn(spec))
  expect(err, `expected NodePtyUnavailableError, got ${err}`).toBeInstanceOf(
    NodePtyUnavailableError
  )
  const e = err as InstanceType<typeof NodePtyUnavailableError>
  expect(e.code, `code ${e.code}`).toBe('NODE_PTY_UNAVAILABLE')
  expect(/node-pty is not installed/.test(e.message), `message names the cause: ${e.message}`).toBe(
    true
  )
  expect(attempts, `one load attempt, got ${attempts}`).toBe(1)
})

test('createPty, node-pty missing: an error result, and no -l retry', async () => {
  setDatabase({
    get: async () => ({ project_id: 'proj-1' }),
    all: async () => [],
    run: async () => ({ changes: 0, lastInsertRowid: 0 }),
    batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
  } as unknown as SlayzoneDb)
  setPtyBackend(null) // the in-process default, as before the routing backend is installed
  const fakeWin = {
    isDestroyed: () => false,
    webContents: { send: () => undefined }
  } as unknown as PtySessionWindow
  const before = attempts
  const res = await createPty({
    win: fakeWin,
    sessionId: 'missing:missing',
    cwd: '/tmp',
    mode: 'terminal'
  } as never)
  expect(res.success, `createPty must fail, got ${JSON.stringify(res)}`).toBe(false)
  expect(/node-pty/.test(res.error ?? ''), `error names node-pty: ${res.error}`).toBe(true)
  expect(attempts - before, `one spawn attempt, got ${attempts - before}`).toBe(1)
})

test('node-pty installed later: the next spawn loads it', async () => {
  blocked = false
  const p = spawnLocalPty(
    '/bin/echo',
    ['slz-node-pty-ok'],
    { cwd: '/tmp', env: { PATH: '/usr/bin:/bin' }, cols: 80, rows: 24, name: 'xterm' },
    true
  )
  let out = ''
  p.onData((d) => {
    out += d
  })
  await new Promise<void>((resolve) => {
    p.onExit(() => resolve())
    setTimeout(resolve, 5_000)
  })
  expect(out, `echo output, got ${JSON.stringify(out)}`).toContain('slz-node-pty-ok')
})

afterAll(() => {
  loader._resolveFilename = realResolve
  setSecurityLogSink()
})
