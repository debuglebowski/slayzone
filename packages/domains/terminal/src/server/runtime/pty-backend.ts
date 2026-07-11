import * as pty from 'node-pty'
import { wrapShellWithUlimit } from '../shell-env'

/**
 * Hub/runner split (wave 2, Model A): the OS-level `node-pty` spawn — the ONLY
 * piece a remote runner replaces — pulled behind a backend seam. pty-manager
 * still owns everything else (session state, buffers, DB writes, the -l / shell
 * fallback orchestration) and calls `getPtyBackend().spawn(spec)` at each of its
 * spawn sites (initial + the two onExit recovery re-spawns). Default is the
 * in-process `localPtyBackend`, so behavior is byte-identical until a later wave
 * injects a remote backend via `setPtyBackend`.
 */

/** Everything the exec side needs to spawn one PTY. `runnerId === null` means
 *  the session runs locally on the hub (today's only path). A remote backend
 *  reads `runnerId`/`sessionId`/`taskId` to route; the local backend ignores
 *  them and just spawns `file`/`args` with `options`. */
export interface PtySpawnSpec {
  sessionId: string
  taskId: string
  runnerId: string | null
  file: string
  args: string[]
  options: {
    cwd: string
    env: Record<string, string>
    cols: number
    rows: number
    name: string
  }
  /** docker/ssh transport spawn — skip the ulimit wrap (the remote side owns
   *  its own env). Mirrors the former `spawnWrappedShell(..., transport)` flag. */
  transport: boolean
}

/**
 * Structural superset of node-pty's `IPty`, limited to the members pty-manager
 * actually touches — verified against every `.pid` / `.process` / `.fd` /
 * `.onData` / `.onExit` / `.write` / `.resize` / `.kill` site in pty-manager.ts
 * (it never calls `.pause` / `.resume` / `.clear` / `.on`). A local spawn
 * returns the raw IPty, which already satisfies this, so downstream code is
 * unchanged. A remote backend returns a proxy of the same shape with `fd`
 * undefined — so the sync-query `writeSync(fd)` path throws and falls through to
 * its `pty.write()` fallback naturally, no remote-specific branch needed.
 */
export interface PtyHandle {
  readonly pid: number
  readonly process: string
  readonly fd?: number
  onData(cb: (data: string) => void): { dispose(): void }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface PtyBackend {
  spawn(spec: PtySpawnSpec): PtyHandle | Promise<PtyHandle>
}

/**
 * The in-process spawn primitive (identical to the former `spawnWrappedShell`):
 * non-transport spawns are wrapped in `/bin/sh -c 'ulimit -n 65535; exec
 * <shell> <args>'` so child processes inherit a soft fd limit high enough for
 * Bun-compiled CLIs (e.g. droid); transport (docker/ssh) spawns run as-is.
 * Exported so pty-manager's warm-pool `spawnLoginShell` shares the exact same
 * primitive rather than duplicating the wrap logic.
 */
export function spawnLocalPty(
  file: string,
  args: string[],
  options: pty.IPtyForkOptions,
  transport: boolean
): pty.IPty {
  if (transport) return pty.spawn(file, args, options)
  const wrapped = wrapShellWithUlimit(file, args)
  return pty.spawn(wrapped.file, wrapped.args, options)
}

/** Default backend: spawn in-process via node-pty. The returned raw IPty is a
 *  structural `PtyHandle`, so callers keep it as-is. Synchronous — the -l /
 *  shell fallbacks in pty-manager rely on a synchronous spawn (and their onExit
 *  recovery re-spawns run inside a synchronous callback). */
export const localPtyBackend: PtyBackend = {
  spawn(spec: PtySpawnSpec): PtyHandle {
    return spawnLocalPty(spec.file, spec.args, spec.options, spec.transport)
  }
}

// Active backend. Callers re-read this ref on EVERY spawn, so a swap only takes
// effect for spawns issued after it — never mid-session. Swap ONLY at a boot or
// reconnect quiesce point (no in-flight spawn/exit for a session that could
// straddle two backends). `null` resets to the local default.
let ptyBackend: PtyBackend = localPtyBackend

export function getPtyBackend(): PtyBackend {
  return ptyBackend
}

export function setPtyBackend(backend: PtyBackend | null): void {
  ptyBackend = backend ?? localPtyBackend
}
