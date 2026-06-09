import { z } from 'zod'
import {
  listProjectGroups,
  createProjectGroup,
  createFolderWithProjects,
  updateProjectGroup,
  deleteProjectGroup,
  moveProjectToGroup,
  reorderTopLevel,
  reorderProjectsInGroup
} from '@slayzone/projects/server'
import type { TopLevelEntryRef } from '@slayzone/projects/shared'
import { router, publicProcedure } from '../trpc'

// Mirrors the `db:project-groups:*` IPC handlers (projects/electron/handlers.ts).
// Both call the same electron-free store (@slayzone/projects/server), so the
// still-registered IPC handlers and these procedures share one implementation
// while IPC + tRPC coexist. Mutating ops return an authoritative { projects,
// groups } snapshot the renderer replaces state with.
const topLevelEntry = z.object({
  kind: z.enum(['project', 'group']),
  id: z.string()
}) satisfies z.ZodType<TopLevelEntryRef>

export const projectGroupsRouter = router({
  list: publicProcedure.query(({ ctx }) => listProjectGroups(ctx.db)),

  create: publicProcedure
    .input(z.object({ name: z.string().optional() }).optional())
    .mutation(({ ctx, input }) => createProjectGroup(ctx.db, input ?? {})),

  createFolderWithProjects: publicProcedure
    .input(z.object({ projectIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => createFolderWithProjects(ctx.db, input.projectIds)),

  update: publicProcedure
    .input(z.object({ id: z.string(), name: z.string().optional(), collapsed: z.boolean().optional() }))
    .mutation(({ ctx, input }) => updateProjectGroup(ctx.db, input)),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deleteProjectGroup(ctx.db, input.id)),

  moveProject: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        groupId: z.string().nullable(),
        targetIndex: z.number()
      })
    )
    .mutation(({ ctx, input }) =>
      moveProjectToGroup(ctx.db, input.projectId, input.groupId, input.targetIndex)
    ),

  reorderTopLevel: publicProcedure
    .input(z.object({ entries: z.array(topLevelEntry) }))
    .mutation(({ ctx, input }) => reorderTopLevel(ctx.db, input.entries)),

  reorderProjectsInGroup: publicProcedure
    .input(z.object({ groupId: z.string(), projectIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => reorderProjectsInGroup(ctx.db, input.groupId, input.projectIds))
})
