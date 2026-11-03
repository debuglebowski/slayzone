/**
 * The file watcher (it runs on computers): a file named `...` under the watched root
 * once threw in its callback and killed the stream; later changes must still arrive.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { closeAllFileWatchers, subscribeFileWatcher, type FileWatchEvent } from './watcher'

const dirs: string[] = []
afterEach(() => {
  closeAllFileWatchers()
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
