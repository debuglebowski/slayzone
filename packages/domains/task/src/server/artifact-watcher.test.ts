/**
 * artifact-watcher integration test — proves the fs.watch → artifactWatcherEvents
 * path actually fires on a real file write (the runtime behavior behind the tRPC
 * `artifacts.onContentChanged` subscription that the sidecar boot now starts via
 * startArtifactWatcher). Closes the runtime-verification gap for the B3 restore.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, expect, test } from 'vitest'
import {
  startArtifactWatcher,
  closeArtifactWatcher,
  artifactWatcherEvents
} from './artifact-watcher.js'

const tmpDirs: string[] = []
const mkTmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artwatch-'))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

// Wait for the next `content-changed` emit (or null on timeout). The watcher
// debounces 100ms; fs.watch delivery adds a little more — 3s is generous.
const nextContentChanged = (timeoutMs = 3000): Promise<string | null> =>
  new Promise((resolve) => {
    const onChange = (id: string): void => {
      cleanup()
      resolve(id)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)
    const cleanup = (): void => {
      clearTimeout(timer)
      artifactWatcherEvents.off('content-changed', onChange)
    }
    artifactWatcherEvents.on('content-changed', onChange)
  })

test('startArtifactWatcher emits content-changed (artifactId) on a file write under <taskId>/', async () => {
  const dir = mkTmp()
  fs.mkdirSync(path.join(dir, 'task-1'), { recursive: true })
  startArtifactWatcher(dir)
  try {
    // Write after the listener + watcher are attached. Layout: <taskId>/<artifactId><ext>.
    // A write landing before the OS watch stream is live (macOS FSEvents starts a
    // beat after fs.watch returns, longer under parallel-suite load) is never
    // reported, so re-write until one is seen; the overall deadline keeps a dead
    // watcher a failure.
    let seen: string | null = null
    const deadline = Date.now() + 15_000
    for (let i = 0; seen === null && Date.now() < deadline; i++) {
      const event = nextContentChanged(1000)
      fs.writeFileSync(path.join(dir, 'task-1', 'artifact-abc.md'), `# hello ${i}`)
      seen = await event
    }
    expect(seen).toBe('artifact-abc')
  } finally {
    closeArtifactWatcher()
  }
})

test('closeArtifactWatcher stops further emissions', async () => {
  const dir = mkTmp()
  fs.mkdirSync(path.join(dir, 'task-2'), { recursive: true })
  startArtifactWatcher(dir)
  closeArtifactWatcher()
  const event = nextContentChanged(800)
  fs.writeFileSync(path.join(dir, 'task-2', 'artifact-xyz.md'), 'change after close')
  expect(await event).toBeNull()
})
