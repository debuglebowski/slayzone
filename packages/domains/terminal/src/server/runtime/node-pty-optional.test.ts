/**
 * node-pty is OPTIONAL in the published hub (T-30): importing the pty runtime must not
 * load it, a hub with processes off must never load it, and with processes on a missing
 * node-pty is a clear refusal at the spawn — never a crash at import. Once it is there,
 * the next spawn loads it (a failure is not cached).
 *
 * node-pty is "missing" through a Module._resolveFilename hook installed BEFORE the
 * runtime is imported, which also counts every attempt to resolve it.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm --experimental-loader ./packages/shared/test-utils/loader.ts <file>
 */
import Module from 'node:module'
import type { SlayzoneDb } from '@slayzone/platform'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import { setSecurityLogSink } from '@slayzone/platform/security-log'
import type { PtySessionWindow } from '../pty-host'

let passed = 0
let failed = 0
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e}`)
    failed++
  }
}
function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
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

console.log('\nnode-pty optional: loaded on the first local spawn, never at import\n')

await test('importing the pty runtime does not load node-pty', () => {
  expect(attempts === 0, `node-pty resolved ${attempts}x at import`)
  expect(!nodePtyLoaded(), 'node-pty is in the module cache after import')
})

await test('processes off: switch refusal, node-pty never loaded', async () => {
  process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
  try {
    const err = await caught(() => localPtyBackend.spawn(spec))
    expect(isHubSwitchedOffError(err), `expected the switch refusal, got ${err}`)
    expect(attempts === 0 && !nodePtyLoaded(), `node-pty resolved ${attempts}x`)
  } finally {
    delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
  }
})

await test('processes on, node-pty missing: clear refusal at the spawn', async () => {
  const err = await caught(() => localPtyBackend.spawn(spec))
  expect(err instanceof NodePtyUnavailableError, `expected NodePtyUnavailableError, got ${err}`)
  const e = err as InstanceType<typeof NodePtyUnavailableError>
  expect(e.code === 'NODE_PTY_UNAVAILABLE', `code ${e.code}`)
  expect(/node-pty is not installed/.test(e.message), `message names the cause: ${e.message}`)
  expect(attempts === 1, `one load attempt, got ${attempts}`)
})

await test('createPty, node-pty missing: an error result, and no -l retry', async () => {
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
  expect(res.success === false, `createPty must fail, got ${JSON.stringify(res)}`)
  expect(/node-pty/.test(res.error ?? ''), `error names node-pty: ${res.error}`)
  expect(attempts - before === 1, `one spawn attempt, got ${attempts - before}`)
})

await test('node-pty installed later: the next spawn loads it', async () => {
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
  expect(out.includes('slz-node-pty-ok'), `echo output, got ${JSON.stringify(out)}`)
})

loader._resolveFilename = realResolve
setSecurityLogSink()
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
process.exit(0)
