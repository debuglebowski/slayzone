/**
 * Drive the runtime-error path Node itself takes for an `fs.watch` watcher, on every
 * platform, so watch-recovery tests exercise the real failure shape.
 *
 * - Native `FSWatcher` (macOS/Windows `recursive: true`, any non-recursive watch): libuv
 *   reports a negative status; Node closes the handle and emits `error` (EIO) WITHOUT
 *   `close`. We call that exact branch: `_handle.onchange(-5, …)`.
 * - Linux `recursive: true` is Node's JS `FSWatcher` (lib/internal/fs/recursive_watch.js),
 *   which has no `_handle`. Its only runtime error is a failed folder rescan: it emits
 *   `error` and stays open (no `close`). We emit that same error.
 */
import type { FSWatcher } from 'node:fs'

type NativeHandle = { onchange(status: number, event: string, path: string): void }
type MaybeNative = FSWatcher & { _handle?: NativeHandle | null }

const closed = new WeakSet<FSWatcher>()

/** Record `close` so `watcherIsOpen` works for the handle-less Linux recursive watcher. */
export function trackWatcher<W extends FSWatcher>(watcher: W): W {
  watcher.on('close', () => closed.add(watcher))
  return watcher
}

/** Whether the watcher still has a live stream (native handle, or JS watcher not closed). */
export function watcherIsOpen(watcher: FSWatcher): boolean {
  const handle = (watcher as MaybeNative)._handle
  return handle === undefined ? !closed.has(watcher) : handle !== null
}

/** Fail `watcher` the way Node does at runtime on this platform (see file header). */
export function failWatcherNatively(watcher: FSWatcher, path: string): void {
  const handle = (watcher as MaybeNative)._handle
  if (handle !== undefined) {
    if (handle === null) throw new Error('watcher has no native handle left to fail')
    handle.onchange(-5, 'rename', path)
    return
  }
  const error = Object.assign(new Error(`EIO: i/o error, scandir '${path}'`), {
    code: 'EIO',
    errno: -5,
    syscall: 'scandir',
    path
  })
  watcher.emit('error', error)
}
