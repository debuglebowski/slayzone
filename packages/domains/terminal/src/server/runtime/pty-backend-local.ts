/**
 * The in-process node-pty backend: for hosts that start terminals themselves —
 * tests, and nothing in the hub (its default refuses; ./pty-backend). Kept out of
 * the hub's import graph (lint:server-boundary).
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type * as pty from 'node-pty'
import { wrapShellWithUlimit } from '../shell-env'
import {
  NodePtyUnavailableError,
  type PtyBackend,
  type PtyHandle,
  type PtySpawnSpec
} from './pty-backend'

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
  const { spawn } = loadNodePty()
  if (transport) return spawn(file, args, options)
  const wrapped = wrapShellWithUlimit(file, args)
  return spawn(wrapped.file, wrapped.args, options)
}

let nodePty: typeof pty | undefined

/**
 * node-pty, loaded on the first local spawn rather than at import. An import-time load
 * is a top-level `require` in the hub's CJS bundle, which kills the boot of a hub that
 * has no node-pty — including one that would never spawn (processes off). Not cached on
 * failure, so a later spawn retries.
 */
function loadNodePty(): typeof pty {
  if (nodePty) return nodePty
  try {
    nodePty =
      typeof require === 'function'
        ? // CJS bundle (the hub): esbuild keeps this call where it is, external, so it
          // resolves at first use — from the bundle's node_modules or NODE_PATH (the
          // desktop's packaged sidecar) exactly like the import it replaces.
          (require('node-pty') as typeof pty)
        : // Unbundled ESM source (tests under tsx/vitest): no `require` in scope, and
          // `import.meta` is off limits — the hub's CJS bundle compiles this file too,
          // where esbuild warns about it and empties it. Resolve from the entry script
          // instead: in this repo it sits below the hoisted root node_modules.
          (createRequire(process.argv[1] ?? join(process.cwd(), 'index.js'))(
            'node-pty'
          ) as typeof pty)
  } catch (err) {
    throw new NodePtyUnavailableError(err)
  }
  return nodePty
}

/** Spawn in-process via node-pty. The returned raw IPty is a structural
 *  `PtyHandle`, so callers keep it as-is. Synchronous — the -l / shell fallbacks in
 *  pty-manager rely on a synchronous spawn. */
export const localPtyBackend: PtyBackend = {
  spawn(spec: PtySpawnSpec): PtyHandle {
    return spawnLocalPty(spec.file, spec.args, spec.options, spec.transport)
  }
}
