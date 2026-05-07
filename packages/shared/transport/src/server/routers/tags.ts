import { z } from 'zod'
import {
  listAllTags,
  createTag,
  updateTag,
  deleteTag,
  reorderTags,
  getTagsForTask,
  getAllTaskTagIds,
  setTagsForTask,
} from '@slayzone/tags/server'
import { router, publicProcedure } from '../trpc'

const createTagInput = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
  textColor: z.string().optional(),
  projectId: z.string(),
})

const updateTagInput = z.object({
  id: z.string(),
  name: z.string().optional(),
  color: z.string().optional(),
  textColor: z.string().optional(),
  sort_order: z.number().int().optional(),
})

export const tagsRouter = router({
  list: publicProcedure.query(({ ctx }) => listAllTags(ctx.db)),

  create: publicProcedure
    .input(createTagInput)
    .mutation(({ ctx, input }) => createTag(ctx.db, input)),

  update: publicProcedure
    .input(updateTagInput)
    .mutation(({ ctx, input }) => updateTag(ctx.db, input)),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deleteTag(ctx.db, input.id)),

  reorder: publicProcedure
    .input(z.object({ tagIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => {
      reorderTags(ctx.db, input.tagIds)
    }),

  getForTask: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ ctx, input }) => getTagsForTask(ctx.db, input.taskId)),

  getAllTaskTagIds: publicProcedure.query(({ ctx }) => getAllTaskTagIds(ctx.db)),

  setForTask: publicProcedure
    .input(z.object({ taskId: z.string(), tagIds: z.array(z.string()) }))
    .mutation(({ ctx, input }) => {
      setTagsForTask(ctx.db, input.taskId, input.tagIds)
    }),
})
