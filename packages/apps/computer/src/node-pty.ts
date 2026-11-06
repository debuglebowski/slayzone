/**
 * node-pty, loaded at the first terminal spawn — never at import. It is native: on
 * an old glibc or a broken install it does not load, and an import-time load killed
 * the whole computer (git, processes, AI config, usage with it). A failure is not
 * cached: a later spawn retries, so installing it fixes terminals without a restart.
 *
 * @module computer/node-pty
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type * as pty from 'node-pty'

export class NodePtyLoadError extends Error {
  readonly code = 'NODE_PTY_UNAVAILABLE'
  constructor(cause: unknown) {
    super(
      `Terminals cannot start on this computer: node-pty does not load here (${
        cause instanceof Error ? cause.message : String(cause)
      }). Reinstall the computer where node-pty builds; everything else keeps working.`,
      { cause }
    )
    this.name = 'NodePtyLoadError'
  }
}

let loaded: typeof pty | undefined

export function loadNodePty(): typeof pty {
  if (loaded) return loaded
  try {
    loaded =
      typeof require === 'function'
        ? // The computer's CJS bundle: esbuild leaves this call in place, external.
          (require('node-pty') as typeof pty)
        : // Unbundled ESM (tests): resolve from the entry script.
          (createRequire(process.argv[1] ?? join(process.cwd(), 'index.js'))(
            'node-pty'
          ) as typeof pty)
  } catch (err) {
    throw new NodePtyLoadError(err)
  }
  return loaded
}

/** `pty.spawn`, loading node-pty on first use. */
export const spawnNodePty: typeof pty.spawn = (file, args, options) =>
  loadNodePty().spawn(file, args, options)
