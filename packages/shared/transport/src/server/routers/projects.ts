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

  create: publicProcedure
    .input(createProjectInput)
    .mutation(({ ctx, input }) => createProject(ctx.db, input as CreateProjectInput)),

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
