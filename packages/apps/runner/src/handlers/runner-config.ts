/**
 * Runner self-configuration handlers — currently just the path-jail.
 *
 * `allowedRoots` bounds every fs/git/proc path this runner will touch. Before
 * the filesystem ops were routed, the desktop app read and wrote the user's disk
 * directly with no jail at all, so routing them through the co-resident runner —
 * whose supervised default is `[homedir()]` — would have silently stopped
 * working for any project on `/Volumes`, `/opt`, or an external drive. Rather
 * than accept that as a cap, the jail became editable.
 *
 * Writes are applied two ways at once, and both matter:
 *   - persisted to `runner.config.json`, so a restart keeps them;
 *   - written into the LIVE `ctx.config`, so they take effect immediately.
 * The handler modules read `ctx.config.allowedRoots` per call for exactly this
 * reason — a captured array would keep enforcing the boot-time set while the UI
 * reported success.
 *
 * @module runner/handlers/runner-config
 */

import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { updateRunnerConfigFile } from '@slayzone/platform/slayzone-config'
import {
  HubToRunnerMethods,
  runnerGitReadinessParamsSchema,
  runnerSetAllowedRootsParamsSchema,
  type RunnerGitReadinessResult,
  type RunnerSetAllowedRootsResult
} from '@slayzone/runner-transport/shared'
import type { HandlerContext, HubMethodTable } from './types'

export function createRunnerConfigHandlers(ctx: HandlerContext): HubMethodTable {
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
  function setAllowedRoots(rawParams: unknown): RunnerSetAllowedRootsResult {
    const { roots } = runnerSetAllowedRootsParamsSchema.parse(rawParams)

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
        rejected.push({ path: root, reason: 'does not exist on this runner' })
        continue
      }
      if (!applied.includes(real)) applied.push(real)
    }

    // An empty set is refused rather than saved. `coerceRunnerConfig` reads
    // `allowedRoots: []` back as "unset" and falls through to the defaults, so
    // persisting it would apply now and silently revert on the next restart —
    // the worst of both. Say so instead; revoking the runner is the real way to
    // stop it doing work.
    if (applied.length === 0) {
      throw new Error(
        rejected.length > 0
          ? `no usable roots: ${rejected.map((r) => `${r.path} (${r.reason})`).join(', ')}`
          : 'a runner needs at least one allowed root; revoke the runner to stop it entirely'
      )
    }

    // Persist first: a crash between the two leaves the on-disk config ahead of
    // the live one, which a restart reconciles. The reverse — live ahead of
    // disk — silently reverts on restart with no trace of why.
    updateRunnerConfigFile({ allowedRoots: applied })
    ctx.config.allowedRoots = applied
    ctx.log('runner allowedRoots updated', { applied, rejected: rejected.length })

    return { roots: applied, rejected }
  }

  /** Run a command, resolving to its failure message rather than throwing. */
  function probe(cmd: string, args: string[]): Promise<string | null> {
    return new Promise((res) => {
      execFile(cmd, args, { timeout: 15_000 }, (err, _out, stderr) =>
        res(err ? stderr?.trim() || err.message : null)
      )
    })
  }

  /**
   * Report whether this runner can do git work with its own credentials.
   *
   * Reports, never fixes. SlayZone holds no git secrets — agents already push
   * from here using whatever `gh auth` / ssh-agent this machine has — so the
   * useful thing is to make that prerequisite legible instead of taking custody
   * of it. A missing login becomes something an operator fixes once on this box.
   */
  async function gitReadiness(rawParams: unknown): Promise<RunnerGitReadinessResult> {
    const { repoUrl } = runnerGitReadinessParamsSchema.parse(rawParams ?? {})

    const gitErr = await probe('git', ['--version'])
    const ghErr = await probe('gh', ['--version'])
    const ghInstalled = ghErr === null
    // `gh auth status` is only meaningful if gh exists; asking otherwise would
    // report "unauthenticated" for a machine that authenticates over ssh.
    const ghAuthErr = ghInstalled ? await probe('gh', ['auth', 'status']) : 'gh not installed'

    let repoReachable: boolean | undefined
    let repoErr: string | null = null
    if (repoUrl) {
      // The real question: can THIS machine reach THAT repo? A toolchain that
      // exists proves nothing about credentials for a specific remote.
      repoErr = await probe('git', ['ls-remote', '--heads', repoUrl])
      repoReachable = repoErr === null
    }

    const detail = gitErr ?? repoErr ?? (ghInstalled ? ghAuthErr : null)
    return {
      gitInstalled: gitErr === null,
      ghInstalled,
      ghAuthenticated: ghInstalled && ghAuthErr === null,
      ...(repoReachable === undefined ? {} : { repoReachable }),
      ...(detail ? { detail } : {})
    }
  }

  return {
    [HubToRunnerMethods.runnerSetAllowedRoots]: setAllowedRoots,
    [HubToRunnerMethods.runnerGitReadiness]: gitReadiness
  }
}
