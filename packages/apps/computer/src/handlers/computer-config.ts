/**
 * Computer self-configuration handlers — currently just the path-jail.
 *
 * `allowedRoots` bounds every fs/git/proc path this computer will touch. Before
 * the filesystem ops were routed, the desktop app read and wrote the user's disk
 * directly with no jail at all, so routing them through the co-resident computer —
 * whose supervised default is `[homedir()]` — would have silently stopped
 * working for any project on `/Volumes`, `/opt`, or an external drive. Rather
 * than accept that as a cap, the jail became editable.
 *
 * Writes are applied two ways at once, and both matter:
 *   - persisted to `computer.config.json`, so a restart keeps them;
 *   - written into the LIVE `ctx.config`, so they take effect immediately.
 * The handler modules read `ctx.config.allowedRoots` per call for exactly this
 * reason — a captured array would keep enforcing the boot-time set while the UI
 * reported success.
 *
 * @module computer/handlers/computer-config
 */

import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { updateComputerConfigFile } from '@slayzone/platform/slayzone-config'
import {
  HubToComputerMethods,
  computerSetAllowedRootsParamsSchema,
  type ComputerSetAllowedRootsResult
} from '@slayzone/computer-transport/shared'
import type { HandlerContext, HubMethodTable } from './types'

export function createComputerConfigHandlers(ctx: HandlerContext): HubMethodTable {
  /**
   * Validate, canonicalize, persist, and apply a new jail.
   *
   * A root is rejected rather than silently kept when it is relative (the jail
   * compares canonical absolute prefixes, so a relative entry could never match
   * anything) or absent from disk (`assertPathAllowed` skips unresolvable roots,
   * so keeping one would look configured while containing nothing). Both come
   * back in `rejected` so the UI can say which entry did not take, instead of
   * showing a saved list that quietly differs from the enforced one.
   */
  function setAllowedRoots(rawParams: unknown): ComputerSetAllowedRootsResult {
    const { roots } = computerSetAllowedRootsParamsSchema.parse(rawParams)

    const applied: string[] = []
    const rejected: { path: string; reason: string }[] = []
    for (const root of roots) {
      if (!isAbsolute(root)) {
        rejected.push({ path: root, reason: 'not an absolute path' })
        continue
      }
      let real: string
      try {
        real = realpathSync.native(resolve(root))
      } catch {
        rejected.push({ path: root, reason: 'does not exist on this computer' })
        continue
      }
      if (!applied.includes(real)) applied.push(real)
    }

    // An empty set is refused rather than saved. `coerceComputerConfig` reads
    // `allowedRoots: []` back as "unset" and falls through to the defaults, so
    // persisting it would apply now and silently revert on the next restart —
    // the worst of both. Say so instead; revoking the computer is the real way to
    // stop it doing work.
    if (applied.length === 0) {
      throw new Error(
        rejected.length > 0
          ? `no usable roots: ${rejected.map((r) => `${r.path} (${r.reason})`).join(', ')}`
          : 'a computer needs at least one allowed root; revoke the computer to stop it entirely'
      )
    }

    // Persist first: a crash between the two leaves the on-disk config ahead of
    // the live one, which a restart reconciles. The reverse — live ahead of
    // disk — silently reverts on restart with no trace of why.
    updateComputerConfigFile({ allowedRoots: applied })
    ctx.config.allowedRoots = applied
    ctx.log('computer allowedRoots updated', { applied, rejected: rejected.length })

    return { roots: applied, rejected }
  }

  return {
    [HubToComputerMethods.computerSetAllowedRoots]: setAllowedRoots
  }
}
