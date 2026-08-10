/**
 * Runner-side project → path handlers.
 *
 * The hub asks "where is project X on you?" instead of telling each runner where
 * a project lives. That inversion is the whole point: a hub holding one path
 * column had to be wrong about at least one machine as soon as two runners laid
 * the same project out differently.
 *
 * `path: null` is a first-class answer, not an error — "this runner has no
 * checkout of that project" is exactly the state the single column could never
 * express, since it always had *a* path even for a machine that had never seen
 * the project.
 *
 * Every path passes {@link assertPathAllowed} before it is recorded, so a stored
 * mapping can never point outside the jail the runner enforces everywhere else.
 *
 * @module runner/handlers/project
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HubToRunnerMethods,
  projectForgetPathParamsSchema,
  projectEnsureCheckoutParamsSchema,
  projectListParamsSchema,
  projectResolvePathParamsSchema,
  projectSetPathParamsSchema,
  type ProjectEnsureCheckoutResult,
  type ProjectListResult,
  type ProjectResolvePathResult,
  type ProjectSetPathResult,
  RunnerNotificationMethods
} from '@slayzone/runner-transport/shared'
import { assertPathAllowed } from '../config'
import type { ProjectPathStore } from '../project-paths'
import type { HandlerContext, HubMethodTable } from './types'

/**
 * `getStore` rather than a store, because the map is read from disk and the
 * dispatch table is built synchronously. Registering the methods immediately and
 * failing with "not loaded yet" is more honest than leaving them out and
 * answering `unimplemented` — the method exists, its backing file just has not
 * arrived. Same late-bind shape as `setAgentHookUrl`.
 */
export function createProjectHandlers(
  ctx: HandlerContext,
  getStore: () => ProjectPathStore | null
): HubMethodTable {
  const allow = (candidate: string): string => assertPathAllowed(candidate, ctx.config.allowedRoots)
  const store = (): ProjectPathStore => {
    const s = getStore()
    if (!s) throw new Error('project path store is still loading')
    return s
  }

  /**
   * `exists` is reported separately from `path` on purpose. A recorded path whose
   * directory has since been deleted is NOT the same as no mapping: the first is
   * something to re-clone or re-point, the second is a project this machine has
   * simply never held. Collapsing them is how a moved folder turns into a
   * silently wrong answer.
   */
  function resolvePath(rawParams: unknown): ProjectResolvePathResult {
    const { projectId } = projectResolvePathParamsSchema.parse(rawParams)
    const entry = store().get(projectId)
    if (!entry) return { path: null }
    return { path: entry.path, source: entry.source, exists: existsSync(entry.path) }
  }

  async function setPath(rawParams: unknown): Promise<ProjectSetPathResult> {
    const { projectId, path, source } = projectSetPathParamsSchema.parse(rawParams)
    // Jail first: a mapping that points outside allowedRoots would be recorded
    // as fact and then refused by every op that used it.
    const resolved = allow(path)
    const entry = await store().set(projectId, resolved, source)
    ctx.log('project path recorded', { projectId, path: entry.path, source })
    return { path: entry.path }
  }

  async function forgetPath(rawParams: unknown): Promise<{ ok: true }> {
    const { projectId } = projectForgetPathParamsSchema.parse(rawParams)
    // Forgets the MAPPING only. The checkout stays on disk — deleting a user's
    // code on a machine they are not sitting at is unrecoverable, and nothing
    // here has been told to do it.
    await store().forget(projectId)
    ctx.log('project path forgotten', { projectId })
    return { ok: true }
  }

  function list(rawParams: unknown): ProjectListResult {
    projectListParamsSchema.parse(rawParams ?? {})
    return {
      projects: store()
        .list()
        .map((e) => ({
          projectId: e.projectId,
          path: e.path,
          source: e.source,
          exists: existsSync(e.path)
        }))
    }
  }

  /**
   * Make the project usable here, cloning it when remote-git mode allows.
   *
   * Progress rides `checkout.status` — a notification that has existed in the
   * frame contract since v1, emitted by the gateway, and never sent by anybody.
   * This is what it was reserved for: a first agent start becomes a clone, and a
   * clone that takes a minute needs to look like a clone taking a minute rather
   * than a spinner that might be broken.
   */
  async function ensureCheckout(rawParams: unknown): Promise<ProjectEnsureCheckoutResult> {
    const params = projectEnsureCheckoutParamsSchema.parse(rawParams)
    const { projectId, checkoutId, repoUrl, branch, workspaceRoot } = params
    const report = (status: string, detail?: unknown): void => {
      ctx.dialer.notify(RunnerNotificationMethods.checkoutStatus, {
        checkoutId,
        status,
        ...(detail === undefined ? {} : { detail })
      })
    }

    const existing = store().get(projectId)
    if (existing && existsSync(existing.path)) {
      report('ready', { path: existing.path })
      return { path: existing.path, outcome: 'present' }
    }

    // Recorded but gone, and adopted: the user pointed at this folder. Cloning
    // over it could destroy work that was never pushed, and recreating it would
    // be inventing a checkout nobody asked for. Report and stop.
    if (existing && existing.source === 'adopted') {
      report('error', { reason: 'missing', path: existing.path })
      return { path: existing.path, outcome: 'missing' }
    }

    if (!repoUrl) {
      // No mapping and no URL — there is genuinely nothing to do here. Saying so
      // is the whole point; the old single path column would have handed over a
      // directory from some other machine instead.
      report('error', { reason: 'unavailable' })
      return { path: null, outcome: 'unavailable' }
    }

    const root = workspaceRoot ?? ctx.config.allowedRoots[0]
    if (!root) {
      report('error', { reason: 'no-workspace-root' })
      return { path: null, outcome: 'unavailable', error: 'runner has no workspace root' }
    }
    const target = allow(join(root, projectId))

    report('cloning', { path: target, repoUrl })
    try {
      await mkdir(root, { recursive: true })
      await new Promise<void>((resolve, reject) => {
        const args = ['clone', ...(branch ? ['--branch', branch] : []), repoUrl, target]
        // No credential handling: the runner clones with whatever `gh auth` /
        // ssh-agent this machine already has — the same prerequisite its agents
        // rely on to push. SlayZone stores no git secrets and should not start.
        execFile('git', args, { cwd: root }, (err) => (err ? reject(err) : resolve()))
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      report('error', { reason: 'clone-failed', message })
      return { path: null, outcome: 'unavailable', error: message }
    }

    await store().set(projectId, target, 'provisioned')
    report('ready', { path: target })
    ctx.log('project provisioned', { projectId, path: target })
    return { path: target, outcome: 'cloned' }
  }

  return {
    [HubToRunnerMethods.projectEnsureCheckout]: ensureCheckout,
    [HubToRunnerMethods.projectResolvePath]: resolvePath,
    [HubToRunnerMethods.projectSetPath]: setPath,
    [HubToRunnerMethods.projectForgetPath]: forgetPath,
    [HubToRunnerMethods.projectList]: list
  }
}
