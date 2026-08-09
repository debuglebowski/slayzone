/**
 * Workspace filesystem router — browsing the machine that owns a workspace.
 *
 * The desktop cannot answer "what directories exist where this agent will run".
 * A native file dialog browses the DESKTOP's disk, so the path it yields need not
 * exist on the runner; and the hub's own disk is equally wrong once the runner is
 * a separate host. So the hub relays: the runner enumerates, the desktop renders.
 *
 * Every procedure takes a {@link WorkspaceRunnerTarget} — an explicit `runnerId`
 * when the user has picked one, else a task or project to resolve from. The
 * resolution is the pty backend's, injected via `WorkspaceDeps.resolveRunner`, so
 * the picker and the agent can never disagree about which machine is meant.
 *
 * `runnerId: null` in a result means "answered in-process": no runner exists to
 * ask (standalone/fork sidecar, or before the local runner enrolls). It is echoed
 * back on every response so the UI can name the machine it is showing instead of
 * implying a remote one.
 *
 * Registered as `workspace` in router.ts.
 */

import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { getWorkspaceDeps } from '../app-deps'

/** Resolvable address of the machine a call targets. */
const targetInput = z.object({
  runnerId: z.string().nullable().optional(),
  taskId: z.string().optional(),
  projectId: z.string().optional()
})

export const workspaceRouter = router({
  /**
   * Where browsing may start on the target machine, in that machine's idiom
   * (platform + separator), so the client never assumes POSIX or the desktop's OS.
   *
   * An empty `roots` array is a real, actionable state — a runner whose
   * `allowedRoots` is unconfigured refuses all filesystem access — and must be
   * surfaced as such rather than rendered as an empty directory.
   */
  listRoots: publicProcedure.input(targetInput).query(async ({ input }) => {
    const { fs, resolveRunner, isLocalRunner } = getWorkspaceDeps()
    const runnerId = await resolveRunner(input)
    // `isLocal` is what lets the UI decide whether desktop-only affordances
    // ("Reveal in Finder", "Open in editor") make sense for this workspace.
    return { runnerId, isLocal: isLocalRunner(runnerId), ...(await fs.listRoots(runnerId)) }
  }),

  listDir: publicProcedure
    .input(
      targetInput.extend({
        /** Absolute path ON THE TARGET machine. */
        path: z.string().min(1),
        dirsOnly: z.boolean().optional(),
        includeHidden: z.boolean().optional()
      })
    )
    .query(async ({ input }) => {
      const { fs, resolveRunner } = getWorkspaceDeps()
      const runnerId = await resolveRunner(input)
      const res = await fs.listDir(runnerId, input.path, {
        dirsOnly: input.dirsOnly,
        includeHidden: input.includeHidden
      })
      return { runnerId, ...res }
    }),

  mkdir: publicProcedure
    .input(targetInput.extend({ path: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { fs, resolveRunner } = getWorkspaceDeps()
      const runnerId = await resolveRunner(input)
      const res = await fs.mkdir(runnerId, input.path)
      return { runnerId, ...res }
    }),

  /**
   * Replace a runner's path-jail (Settings → Runners).
   *
   * Routing the filesystem through runners gave the co-resident local runner's
   * `[homedir()]` default authority over ops the desktop previously ran unjailed
   * — so a project on `/Volumes` or `/opt` would have stopped working. This is
   * the escape hatch that keeps that from being a cap.
   *
   * Returns what was actually applied plus what was rejected, so the UI can name
   * the entry that did not take rather than showing a list that silently differs
   * from the enforced one.
   */
  setAllowedRoots: publicProcedure
    .input(targetInput.extend({ roots: z.array(z.string().min(1)) }))
    .mutation(async ({ input }) => {
      const { fs, resolveRunner } = getWorkspaceDeps()
      const runnerId = await resolveRunner(input)
      return { runnerId, ...(await fs.setAllowedRoots(runnerId, input.roots)) }
    }),

  /**
   * Does a path exist on the target machine?
   *
   * This is the honest replacement for `app.files.pathExists`, which always
   * probed the hub. `reachable: false` distinguishes "the runner said no" from
   * "we could not ask" — collapsing those is what produced a permanent
   * "No repository path configured" for a path that was fine.
   */
  pathExists: publicProcedure
    .input(targetInput.extend({ path: z.string().min(1) }))
    .query(async ({ input }) => {
      const { fs, resolveRunner } = getWorkspaceDeps()
      const runnerId = await resolveRunner(input)
      try {
        return { runnerId, exists: await fs.pathExists(runnerId, input.path), reachable: true }
      } catch (err) {
        return {
          runnerId,
          exists: false,
          reachable: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    })
})
