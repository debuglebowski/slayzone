/**
 * artifact-watcher integration test — proves the fs.watch → artifactWatcherEvents
 * path actually fires on a real file write (the runtime behavior behind the tRPC
 * `artifacts.onContentChanged` subscription that the sidecar boot now starts via
 * startArtifactWatcher). Closes the runtime-verification gap for the B3 restore.
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { test, expect } from '../../../../shared/test-utils/ipc-harness.js'
import {
  startArtifactWatcher,
  closeArtifactWatcher,
  artifactWatcherEvents
} from './artifact-watcher.js'

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artwatch-'))
  fs.mkdirSync(path.join(dir, 'task-1'), { recursive: true })
  startArtifactWatcher(dir)
  try {
    const event = nextContentChanged()
    // Write after the listener + watcher are attached. Layout: <taskId>/<artifactId><ext>.
    fs.writeFileSync(path.join(dir, 'task-1', 'artifact-abc.md'), '# hello')
    expect(await event).toBe('artifact-abc')
  } finally {
    closeArtifactWatcher()
  }
})

test('closeArtifactWatcher stops further emissions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artwatch-'))
  fs.mkdirSync(path.join(dir, 'task-2'), { recursive: true })
  startArtifactWatcher(dir)
  closeArtifactWatcher()
  const event = nextContentChanged(800)
  fs.writeFileSync(path.join(dir, 'task-2', 'artifact-xyz.md'), 'change after close')
  expect(await event).toBeNull()
})
