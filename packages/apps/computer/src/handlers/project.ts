/**
 * Computer-side project → path handlers.
 *
 * The hub asks "where is project X on you?" instead of telling each computer where
 * a project lives. That inversion is the whole point: a hub holding one path
 * column had to be wrong about at least one machine as soon as two computers laid
 * the same project out differently.
 *
 * `path: null` is a first-class answer, not an error — "this computer has no
 * checkout of that project" is exactly the state the single column could never
 * express, since it always had *a* path even for a machine that had never seen
 * the project.
 *
 * Every path passes {@link judgePath} before it is recorded, so a stored
 * mapping can never point outside the jail the computer enforces everywhere else.
 *
 * @module computer/handlers/project
 */

import { existsSync } from 'node:fs'
import {
  HubToComputerMethods,
  projectForgetPathParamsSchema,
  projectListParamsSchema,
  projectResolvePathParamsSchema,
  projectSetPathParamsSchema,
  projectRelocateParamsSchema,
  projectOriginParamsSchema,
  projectCloneParamsSchema,
  type ProjectOriginResult,
  type ProjectListResult,
  type ProjectResolvePathResult,
  type ProjectSetPathResult
} from '@slayzone/computer-transport/shared'
import { judgePath } from '../path-jail'
import type { ProjectPathStore } from '../project-paths'
import type { HandlerContext, HubMethodTable } from './types'
import { createProjectRelocation } from '../project-relocation'
import { cloneInto, originOf } from '../git-clone'

/**
 * `getStore` rather than a store, because the map is read from disk and the
 * dispatch table is built synchronously. Registering the methods immediately and
 * failing with "not loaded yet" is more honest than leaving them out and
 * answering `unimplemented` — the method exists, its backing file just has not
 * arrived. Same late-bind shape as `setAgentHookUrl`.
 */
export function createProjectHandlers(
  ctx: HandlerContext,
  getStore: () => ProjectPathStore | null,
  relocation?: {
    assertIdle(projectId: string): void | Promise<void>
    remap(projectId: string, source: string, target: string): void | Promise<void>
  }
): HubMethodTable & { recoverRelocation(): Promise<void>; assertRelocationAvailable(): void } {
  const allow = (candidate: string): string => judgePath(candidate, ctx.config.allowedRoots)
  const store = (): ProjectPathStore => {
    const s = getStore()
    if (!s) throw new Error('project path store is still loading')
    return s
  }
  const mover = createProjectRelocation({
    store,
    roots: () => [...ctx.config.allowedRoots],
    assertIdle: (projectId) => relocation?.assertIdle(projectId),
    remap: (projectId, source, target) => relocation?.remap(projectId, source, target)
  })

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
    return { path: entry.path, exists: existsSync(entry.path) }
  }

  async function setPath(rawParams: unknown): Promise<ProjectSetPathResult> {
    await mover.recover()
    mover.assertAvailable()
    const { projectId, path } = projectSetPathParamsSchema.parse(rawParams)
    // Jail first: a mapping that points outside allowedRoots would be recorded
    // as fact and then refused by every op that used it.
    const resolved = allow(path)
    const entry = await store().set(projectId, resolved)
    ctx.log('project path recorded', { projectId, path: entry.path })
    return { path: entry.path }
  }

  async function forgetPath(rawParams: unknown): Promise<{ ok: true }> {
    await mover.recover()
    mover.assertAvailable()
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
          exists: existsSync(e.path)
        }))
    }
  }

  return {
    recoverRelocation: mover.recover,
    assertRelocationAvailable: mover.assertAvailable,
    [HubToComputerMethods.projectResolvePath]: resolvePath,
    [HubToComputerMethods.projectSetPath]: setPath,
    [HubToComputerMethods.projectRelocate]: async (raw: unknown) => {
      await mover.recover()
      const { projectId, sourcePath, path, mode } = projectRelocateParamsSchema.parse(raw)
      return mover.move(projectId, sourcePath, path, mode)
    },
    [HubToComputerMethods.projectOrigin]: async (raw: unknown): Promise<ProjectOriginResult> => {
      const { projectId } = projectOriginParamsSchema.parse(raw)
      const entry = store().get(projectId)
      return { url: entry ? await originOf(entry.path) : null }
    },
    // Clone, then record the clone as this project's folder here.
    [HubToComputerMethods.projectClone]: async (raw: unknown): Promise<ProjectSetPathResult> => {
      await mover.recover()
      mover.assertAvailable()
      const { projectId, path, url } = projectCloneParamsSchema.parse(raw)
      const cloned = await cloneInto(url, path, ctx.config.allowedRoots)
      const entry = await store().set(projectId, cloned)
      ctx.log('project cloned', { projectId, path: entry.path })
      return { path: entry.path }
    },
    [HubToComputerMethods.projectForgetPath]: forgetPath,
    [HubToComputerMethods.projectList]: list
  }
}
