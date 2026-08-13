/**
 * Workspace filesystem router — browsing the machine that owns a workspace.
 *
 * The desktop cannot answer "what directories exist where this agent will run".
 * A native file dialog browses the DESKTOP's disk, so the path it yields need not
 * exist on the computer; and the hub's own disk is equally wrong once the computer is
 * a separate host. So the hub relays: the computer enumerates, the desktop renders.
 *
 * Every procedure takes a {@link WorkspaceComputerTarget} — an explicit `computerId`
 * when the user has picked one, else a task or project to resolve from. The
 * resolution is the pty backend's, injected via `WorkspaceDeps.resolveComputer`, so
 * the picker and the agent can never disagree about which machine is meant.
 *
 * `computerId: null` in a result means "answered in-process": no computer exists to
 * ask (standalone/fork sidecar, or before the local computer enrolls). It is echoed
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
  computerId: z.string().nullable().optional(),
  taskId: z.string().optional(),
  projectId: z.string().optional()
})

export const workspaceRouter = router({
  /**
   * Where browsing may start on the target machine, in that machine's idiom
   * (platform + separator), so the client never assumes POSIX or the desktop's OS.
   *
   * An empty `roots` array is a real, actionable state — a computer whose
   * `allowedRoots` is unconfigured refuses all filesystem access — and must be
   * surfaced as such rather than rendered as an empty directory.
   */
  listRoots: publicProcedure.input(targetInput).query(async ({ input }) => {
    const { fs, resolveComputer, isLocalComputer } = getWorkspaceDeps()
    const computerId = await resolveComputer(input)
    // `isLocal` is what lets the UI decide whether desktop-only affordances
    // ("Reveal in Finder", "Open in editor") make sense for this workspace.
    return { computerId, isLocal: isLocalComputer(computerId), ...(await fs.listRoots(computerId)) }
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
      const { fs, resolveComputer } = getWorkspaceDeps()
      const computerId = await resolveComputer(input)
      const res = await fs.listDir(computerId, input.path, {
        dirsOnly: input.dirsOnly,
        includeHidden: input.includeHidden
      })
      return { computerId, ...res }
    }),

  mkdir: publicProcedure
    .input(targetInput.extend({ path: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { fs, resolveComputer } = getWorkspaceDeps()
      const computerId = await resolveComputer(input)
      const res = await fs.mkdir(computerId, input.path)
      return { computerId, ...res }
    }),

  /**
   * Replace a computer's path-jail (Settings → Computers).
   *
   * Routing the filesystem through computers gave the co-resident local computer's
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
      const { fs, resolveComputer } = getWorkspaceDeps()
      const computerId = await resolveComputer(input)
      return { computerId, ...(await fs.setAllowedRoots(computerId, input.roots)) }
    }),

  /**
   * Where does the target machine keep this project?
   *
   * `path: null` means that machine has no checkout — the honest answer the
   * hub's single `projects.path` column could never give, since it always had
   * *a* path even for a computer that had never seen the project. `exists: false`
   * is different again: recorded, but the folder is gone.
   */
  resolveProjectPath: publicProcedure
    .input(targetInput.extend({ projectId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { fs, resolveComputer } = getWorkspaceDeps()
      const computerId = await resolveComputer(input)
      try {
        return {
          computerId,
          reachable: true,
          ...(await fs.resolveProjectPath(computerId, input.projectId))
        }
      } catch (err) {
        // Could not ask ≠ not checked out. Reporting `path: null` for an offline
        // computer would send the user to re-adopt a checkout that is fine.
        return {
          computerId,
          reachable: false,
          path: null,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }),

  /** Adopt an existing folder on the target machine as this project's checkout. */
  setProjectPath: publicProcedure
    .input(
      targetInput.extend({
        projectId: z.string().min(1),
        path: z.string().min(1)
      })
    )
    .mutation(async ({ input }) => {
      const { fs, resolveComputer } = getWorkspaceDeps()
      const computerId = await resolveComputer(input)
      return {
        computerId,
        ...(await fs.setProjectPath(computerId, input.projectId, input.path))
      }
    }),

  /** Drop the mapping on that machine. The checkout itself is left alone. */
  forgetProjectPath: publicProcedure
    .input(targetInput.extend({ projectId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { fs, resolveComputer } = getWorkspaceDeps()
      const computerId = await resolveComputer(input)
      await fs.forgetProjectPath(computerId, input.projectId)
      return { computerId, ok: true as const }
    }),

  /**
   * Does a path exist on the target machine?
   *
   * This is the honest replacement for `app.files.pathExists`, which always
   * probed the hub. `reachable: false` distinguishes "the computer said no" from
   * "we could not ask" — collapsing those is what produced a permanent
   * "No repository path configured" for a path that was fine.
   */
  pathExists: publicProcedure
    .input(targetInput.extend({ path: z.string().min(1) }))
    .query(async ({ input }) => {
      const { fs, resolveComputer } = getWorkspaceDeps()
      const computerId = await resolveComputer(input)
      try {
        return { computerId, exists: await fs.pathExists(computerId, input.path), reachable: true }
      } catch (err) {
        return {
          computerId,
          exists: false,
          reachable: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    })
})
