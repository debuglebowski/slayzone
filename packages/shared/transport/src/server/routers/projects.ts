import { join } from 'node:path'
import { z } from 'zod'
import {
  listAllProjects,
  createProject,
  updateProject,
  deleteProject,
  uploadProjectIcon,
  reorderProjects
} from '@slayzone/projects/server'
import type { CreateProjectInput, UpdateProjectInput } from '@slayzone/projects/shared'
import { router, publicProcedure } from '../trpc'
import { getComputersDepsOrNull } from '../app-deps'

const createProjectInput = z.object({
  name: z.string().min(1),
  color: z.string(),
  path: z.string().optional(),
  columnsConfig: z.array(z.unknown()).optional()
})

// UpdateProjectInput is 16 mixed optional fields; a faithful schema would be ~60
// lines of repetition for trusted-network scope-1. Trust the statically-checked
// renderer (slice 5) and skip runtime validation here; add a strict schema when
// auth lands. Mirrors the tags-pilot / phase-0 reference rationale.
const updateProjectInput = z.unknown() as unknown as z.ZodType<UpdateProjectInput>

// Icon dir derived from the context's dataRoot so the store stays electron-free.
const iconsDir = (dataRoot: string): string => join(dataRoot, 'project-icons')

export const projectsRouter = router({
  list: publicProcedure.query(({ ctx }) => listAllProjects(ctx.db)),

  /**
   * Create a project.
   *
   * Refused when no computer can hold it. A project's files live on a computer, so
   * with none connected there is nowhere to put a path and nowhere its agents
   * could run — and the picker would quietly browse the hub's own disk, which is
   * exactly the wrong-machine confusion this seam removes. Better to say so at
   * the one moment the user is looking at it.
   *
   * The check is `listUsableComputers`, not `listComputers`: a socket that is open but
   * silent cannot take work, and offering to create against it would produce a
   * project whose first agent start hangs.
   */
  create: publicProcedure.input(createProjectInput).mutation(({ ctx, input }) => {
    const gateway = getComputersDepsOrNull()?.getGateway()
    // No gateway wired at all = the fork sidecar or a pre-init boot, where this
    // process IS the only machine. Not the "no computer" case, so not refused.
    if (gateway && gateway.listUsableComputers().length === 0) {
      throw new Error(
        'No computer is connected, so a project has no machine to live on. ' +
          'Start the local computer (Settings → Connections) or enroll one, then try again.'
      )
    }
    return createProject(ctx.db, input as CreateProjectInput)
  }),

  update: publicProcedure
    .input(updateProjectInput)
    .mutation(({ ctx, input }) => updateProject(ctx.db, input, iconsDir(ctx.dataRoot))),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deleteProject(ctx.db, input.id, iconsDir(ctx.dataRoot))),

  uploadIcon: publicProcedure
    .input(z.object({ projectId: z.string(), sourcePath: z.string() }))
    .mutation(({ ctx, input }) =>
      uploadProjectIcon(ctx.db, iconsDir(ctx.dataRoot), input.projectId, input.sourcePath)
    ),

  reorder: publicProcedure
    .input(z.object({ projectIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => reorderProjects(ctx.db, input.projectIds))
})
