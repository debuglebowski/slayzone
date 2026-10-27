/**
 * Process-TREE kill, for a spawn that is a tree rather than one process.
 *
 * A shell-wrapped command (`pnpm dev`) is the shell plus everything it started.
 * Signalling the shell alone leaves the rest running — orphaned to PID 1, still
 * holding the stdout pipe, so the exit is never even observed. On POSIX the leader
 * must be spawned with `detached: true` (`setsid()`: it leads its own process
 * group) so the whole group can be signalled at once; on Windows `taskkill /T`
 * walks the tree from any pid (and is always forceful — there is no SIGTERM).
 *
 * Shared by every spawner that owns such trees: the hub-local process backend and
 * the computer's `proc` handler, which used to signal only its direct child.
 */
// eslint-disable-next-line no-restricted-imports -- Windows-only `taskkill` on process kill (returns at once).
import { execFileSync } from 'node:child_process'

/** Spawn option a tree's leader needs for {@link killPidTree} to reach the whole tree. */
export const PROCESS_TREE_DETACHED = process.platform !== 'win32'

/** Kill the tree rooted at `pid` — the leader of a detached POSIX group, or any pid
 *  on Windows. Errors (already gone, not permitted) are swallowed. */
export function killPidTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)])
    } catch {
      // ignore
    }
  } else {
    try {
      process.kill(-pid, signal)
    } catch {
      // ignore
    }
  }
}
