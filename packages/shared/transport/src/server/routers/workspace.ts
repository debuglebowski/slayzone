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
   * Where does the target machine keep this project?
   *
   * `path: null` means that machine has no checkout — the honest answer the
   * hub's single `projects.path` column could never give, since it always had
   * *a* path even for a runner that had never seen the project. `exists: false`
   * is different again: recorded, but the folder is gone.
   */
  resolveProjectPath: publicProcedure
    .input(targetInput.extend({ projectId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { fs, resolveRunner } = getWorkspaceDeps()
      const runnerId = await resolveRunner(input)
      try {
        return {
          runnerId,
          reachable: true,
          ...(await fs.resolveProjectPath(runnerId, input.projectId))
        }
      } catch (err) {
        // Could not ask ≠ not checked out. Reporting `path: null` for an offline
        // runner would send the user to re-adopt a checkout that is fine.
        return {
          runnerId,
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
        path: z.string().min(1),
        source: z.enum(['adopted', 'provisioned']).default('adopted')
      })
    )
    .mutation(async ({ input }) => {
      const { fs, resolveRunner } = getWorkspaceDeps()
      const runnerId = await resolveRunner(input)
      return {
        runnerId,
        ...(await fs.setProjectPath(runnerId, input.projectId, input.path, input.source))
      }
    }),

  /**
   * Make a project usable on the target machine, cloning it when the project is
   * in remote-git mode.
   *
   * Called before an agent session starts — the one moment that has everything:
   * the runner knows its disk, the hub knows the project's identity, and the user
   * is present, so a clone reads as progress rather than a background surprise.
   * Progress streams as `checkout.status`.
   */
  ensureCheckout: publicProcedure
    .input(targetInput.extend({ projectId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { fs, resolveRunner } = getWorkspaceDeps()
      const runnerId = await resolveRunner(input)
      // Remote-git mode is what permits CREATING a checkout. Without a URL the
      // runner reports a missing folder rather than recreating one the user
      // chose — cloning over it could destroy unpushed work.
      const project = await ctx.db.get<{
        git_mode: string | null
        repo_url: string | null
        default_branch: string | null
      }>('SELECT git_mode, repo_url, default_branch FROM projects WHERE id = ?', [input.projectId])
      const remote = project?.git_mode === 'remote' && project.repo_url
      return {
        runnerId,
        ...(await fs.ensureProjectCheckout(runnerId, {
          projectId: input.projectId,
          checkoutId: `${input.projectId}:${Date.now()}`,
          ...(remote ? { repoUrl: project.repo_url as string } : {}),
          ...(remote && project.default_branch ? { branch: project.default_branch } : {})
        }))
      }
    }),

  /**
   * Can that machine do git work with the credentials it already has?
   *
   * SlayZone stores no git secrets and should not start — agents already push
   * from the runner using its own `gh auth` / ssh-agent. This makes the
   * prerequisite visible so a missing login is fixed once on that box, rather
   * than surfacing as a clone that dies mid-provision.
   */
  gitReadiness: publicProcedure
    .input(targetInput.extend({ repoUrl: z.string().min(1).optional() }))
    .query(async ({ input }) => {
      const { fs, resolveRunner } = getWorkspaceDeps()
      const runnerId = await resolveRunner(input)
      try {
        return { runnerId, reachable: true, ...(await fs.gitReadiness(runnerId, input.repoUrl)) }
      } catch (err) {
        return {
          runnerId,
          reachable: false,
          gitInstalled: false,
          ghInstalled: false,
          ghAuthenticated: false,
          detail: err instanceof Error ? err.message : String(err)
        }
      }
    }),

  /** Drop the mapping on that machine. The checkout itself is left alone. */
  forgetProjectPath: publicProcedure
    .input(targetInput.extend({ projectId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { fs, resolveRunner } = getWorkspaceDeps()
      const runnerId = await resolveRunner(input)
      await fs.forgetProjectPath(runnerId, input.projectId)
      return { runnerId, ok: true as const }
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
