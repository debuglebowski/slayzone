/**
 * node-pty is a native module: on an old glibc, or a broken install, it does not
 * load. Imported at module load, that killed the whole computer — and with it git,
 * processes, AI config and usage, which never needed it. It loads at the first
 * terminal spawn instead; a missing one fails that spawn with a clear error and
 * leaves everything else running. A failure is not cached: a later spawn retries.
 *
 * node-pty is "missing" through a Module._resolveFilename hook installed BEFORE
 * the handlers are imported, which also counts every attempt to resolve it.
 */
import Module from 'node:module'
import { afterAll, expect, test } from 'vitest'

type Resolve = (request: string, ...rest: unknown[]) => string
const loader = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown> }
const nodePtyLoaded = (): boolean =>
  Object.keys(loader._cache).some((k) => k.includes('/node-pty/'))
const realResolve = loader._resolveFilename
let blocked = true
loader._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
  if (request === 'node-pty' && blocked) {
    throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' })
  }
  return realResolve.call(this, request, ...rest)
}
afterAll(() => {
  loader._resolveFilename = realResolve
})

const { createPtyHandlers } = await import('./handlers/pty')
const { probeNativeTerminal } = await import('./native-probe')

const ctx = {
  dialer: { notify: () => true },
  config: {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [process.cwd()],
    capabilities: ['pty']
  },
  log: () => {}
}

test('importing the terminal handlers does not load node-pty', () => {
  expect(nodePtyLoaded(), 'node-pty is in the module cache after import').toBe(false)
})

test('a spawn with node-pty missing fails with a clear error; the computer stays up', async () => {
  const pty = createPtyHandlers(ctx as never)
  const err = await Promise.resolve()
    .then(() => pty.handlers['pty.spawn']({ sessionId: 's1', command: 'sh', cwd: process.cwd() }))
    .then(
      () => null,
      (e: unknown) => e
    )
  expect(err).toBeInstanceOf(Error)
  expect((err as Error).message).toMatch(/node-pty/)
  pty.disposeAll()
})

test('the native terminal probe rejects instead of crashing the process', async () => {
  await expect(probeNativeTerminal()).rejects.toThrow(/node-pty/)
})

test('installed later: the next spawn loads it', async () => {
  blocked = false
  const pty = createPtyHandlers(ctx as never)
  const res = (await pty.handlers['pty.spawn']({
    sessionId: 's2',
    command: 'sh',
    args: ['-c', 'exit 0'],
    cwd: process.cwd()
  })) as { pid: number }
  expect(res.pid).toBeGreaterThan(0)
  pty.disposeAll()
})
