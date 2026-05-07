import { z } from 'zod'
import {
  listAllProjects,
  createProject,
  updateProject,
  deleteProject,
  uploadProjectIcon,
  reorderProjects,
} from '@slayzone/projects/server'
import type { CreateProjectInput, UpdateProjectInput } from '@slayzone/projects/shared'
import { router, publicProcedure } from '../trpc'

const createProjectInputSchema = z.object({
  name: z.string().min(1),
  color: z.string(),
  path: z.string().optional(),
  columnsConfig: z.array(z.unknown()).optional(),
}).passthrough()

// UpdateProjectInput has 15+ optional fields with mixed types. Schema would be
// 60 lines of repetition for trusted-network scope-1. Trust the TS interface
// (renderer is statically checked) and skip runtime validation here. When auth
// lands in scope-2 (master §11b), add a strict schema.
const updateProjectInputSchema = z.unknown() as unknown as z.ZodType<UpdateProjectInput>

export const projectsRouter = router({
  list: publicProcedure.query(({ ctx }) => listAllProjects(ctx.db)),

  create: publicProcedure
    .input(createProjectInputSchema)
    .mutation(({ ctx, input }) => createProject(ctx.db, input as CreateProjectInput)),

  update: publicProcedure
    .input(updateProjectInputSchema)
    .mutation(({ ctx, input }) => updateProject(ctx.db, input)),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deleteProject(ctx.db, input.id)),

  uploadIcon: publicProcedure
    .input(z.object({ projectId: z.string(), sourcePath: z.string() }))
    .mutation(({ ctx, input }) => uploadProjectIcon(ctx.db, input.projectId, input.sourcePath)),

  reorder: publicProcedure
    .input(z.object({ projectIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => {
      reorderProjects(ctx.db, input.projectIds)
    }),
})
