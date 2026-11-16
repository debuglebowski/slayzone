/**
 * The file watcher (it runs on computers): a file named `...` under the watched root
 * once threw in its callback and killed the stream; later changes must still arrive.
 */
import * as nativeFs from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { closeAllFileWatchers, subscribeFileWatcher, type FileWatchEvent } from './watcher'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, watch: vi.fn(fs.watch) }
})

const dirs: string[] = []
afterEach(() => {
  closeAllFileWatchers()
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('a file named "..." does not stop the watch', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slz-watch-dots-')))
  dirs.push(dir)
  const seen: FileWatchEvent[] = []
  subscribeFileWatcher(dir, (e) => seen.push(e))
  await new Promise((r) => setTimeout(r, 200))
  mkdirSync(join(dir, '...'))
  await new Promise((r) => setTimeout(r, 300))
  writeFileSync(join(dir, 'after.txt'), 'x')
  await vi.waitFor(() => expect(seen.map((e) => e.relPath)).toContain('after.txt'), {
    timeout: 8000
  })
}, 12_000)

type NativeWatcher = nativeFs.FSWatcher & {
  _handle: { onchange(status: number, event: string, path: string): void } | null
}
async function observeNative() {
  const actualWatch = (await vi.importActual<typeof import('node:fs')>('node:fs')).watch
  const opened: NativeWatcher[] = []
  const closed = new Set<NativeWatcher>()
  vi.spyOn(nativeFs, 'watch').mockImplementation((...args) => {
    const watcher = Reflect.apply(actualWatch, nativeFs, args) as NativeWatcher
    opened.push(watcher)
    watcher.on('close', () => closed.add(watcher))
    return watcher
  })
  return { opened, closed }
}
function directory() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'slz-watch-recovery-')))
  dirs.push(root)
  return root
}
let probeId = 0
async function ready(root: string, seen: FileWatchEvent[]) {
  const probes = new Set<string>()
  await vi.waitFor(
    () => {
      if (seen.some((e) => e.root === root && e.type === 'changed' && probes.has(e.relPath))) return
      const name = `watch-probe-${probeId++}.txt`
      probes.add(name)
      writeFileSync(join(root, name), 'one native creation')
      throw new Error('waiting for this owner’s exact native probe')
    },
    { timeout: 10_000, interval: 200 }
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  seen.length = 0
}
const changes = (seen: FileWatchEvent[], name: string) => seen.filter((e) => e.relPath === name)

test('runtime-error recovery keeps existing owners and rejects stale native lifecycle callbacks', async () => {
  const root = directory(),
    { opened, closed } = await observeNative()
  const a: FileWatchEvent[] = [],
    b: FileWatchEvent[] = [],
    c: FileWatchEvent[] = []
  const stopA = subscribeFileWatcher(root, (event) => a.push(event))
  const stopB = subscribeFileWatcher(root, (event) => b.push(event))
  await ready(root, a)
  expect(opened).toHaveLength(1)
  expect(opened[0]._handle).not.toBeNull()
  opened[0]._handle!.onchange(-5, 'rename', root)
  expect(opened[0]._handle).toBeNull()
  const stopC = subscribeFileWatcher(root, (event) => c.push(event))
  expect(opened).toHaveLength(2)
  await ready(root, c)
  a.length = 0
  b.length = 0
  // Old error/close listeners must never invalidate the recovered generation.
  opened[0].emit('error', new Error('late error from retired native generation'))
  opened[0].emit('close')
  writeFileSync(join(root, 'recovered.txt'), 'one real change for every retained owner')
  await vi.waitFor(
    () => {
      for (const owner of [a, b, c]) expect(changes(owner, 'recovered.txt')).toHaveLength(1)
    },
    { timeout: 5000 }
  )
  stopC()
  stopA()
  stopA()
  expect(opened[1]._handle).not.toBeNull()
  writeFileSync(join(root, 'survivor.txt'), 'only the remaining owner')
  await vi.waitFor(() => expect(changes(b, 'survivor.txt')).toHaveLength(1), { timeout: 5000 })
  expect(changes(a, 'survivor.txt')).toEqual([])
  expect(changes(c, 'survivor.txt')).toEqual([])
  stopB()
  await vi.waitFor(() => expect(closed.has(opened[1])).toBe(true), { timeout: 2000 })
}, 30_000)

test('a stale disposer after closeAll cannot remove the same listener from a fresh entry', async () => {
  const root = directory(),
    { opened, closed } = await observeNative()
  const seen: FileWatchEvent[] = []
  const listener = (event: FileWatchEvent) => seen.push(event)
  const oldStop = subscribeFileWatcher(root, listener)
  closeAllFileWatchers()
  const stop = subscribeFileWatcher(root, listener)
  expect(opened).toHaveLength(2)
  oldStop()
  expect(opened[1]._handle).not.toBeNull()
  await ready(root, seen)
  writeFileSync(join(root, 'fresh.txt'), 'one change on the replacement entry')
  await vi.waitFor(() => expect(changes(seen, 'fresh.txt')).toHaveLength(1), { timeout: 5000 })
  stop()
  await vi.waitFor(() => expect(closed.has(opened[1])).toBe(true), { timeout: 2000 })
}, 20_000)

test('a disposer owns only its subscription when the same listener resubscribes after failure', async () => {
  const root = directory(),
    { opened, closed } = await observeNative()
  const seen: FileWatchEvent[] = []
  const listener = (event: FileWatchEvent) => seen.push(event)
  const oldStop = subscribeFileWatcher(root, listener)
  await ready(root, seen)
  opened[0]._handle!.onchange(-5, 'rename', root)
  const stop = subscribeFileWatcher(root, listener)
  expect(opened).toHaveLength(2)
  oldStop()
  oldStop()
  expect(opened[1]._handle).not.toBeNull()
  await ready(root, seen)
  writeFileSync(join(root, 'same-listener.txt'), 'one write for the surviving subscription')
  await vi.waitFor(() => expect(changes(seen, 'same-listener.txt')).toHaveLength(1), {
    timeout: 5000
  })
  stop()
  await vi.waitFor(() => expect(closed.has(opened[1])).toBe(true), { timeout: 2000 })
}, 30_000)
