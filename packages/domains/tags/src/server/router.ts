import { z } from 'zod'
import {
  listAllTags,
  createTag,
  updateTag,
  deleteTag,
  reorderTags,
  getTagsForTask,
  getAllTaskTagIds,
  setTagsForTask
} from './tag-store'
import { router, publicProcedure } from '@slayzone/trpc-server'
import { getTaskTriggerBus } from './task-trigger-bus'
import { signalBoardChanged, signalTasksChanged } from './tags-router-deps'

const createTagInput = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
  textColor: z.string().optional(),
  projectId: z.string()
})

const updateTagInput = z.object({
  id: z.string(),
  name: z.string().optional(),
  color: z.string().optional(),
  textColor: z.string().optional(),
  sort_order: z.number().int().optional()
})

export const tagsRouter = router({
  list: publicProcedure.query(({ ctx }) => listAllTags(ctx.db)),

  // A project's tags show on every card, filter and picker: each change to the tags
  // themselves reloads every client's board (after the write lands).
  create: publicProcedure.input(createTagInput).mutation(async ({ ctx, input }) => {
    const tag = await createTag(ctx.db, input)
    signalBoardChanged()
    return tag
  }),

  update: publicProcedure.input(updateTagInput).mutation(async ({ ctx, input }) => {
    const tag = await updateTag(ctx.db, input)
    signalBoardChanged()
    return tag
  }),

  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const result = await deleteTag(ctx.db, input.id)
    signalBoardChanged()
    return result
  }),

  reorder: publicProcedure
    .input(z.object({ tagIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      const result = await reorderTags(ctx.db, input.tagIds)
      signalBoardChanged()
      return result
    }),

  getForTask: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ ctx, input }) => getTagsForTask(ctx.db, input.taskId)),

  getAllTaskTagIds: publicProcedure.query(({ ctx }) => getAllTaskTagIds(ctx.db)),

  setForTask: publicProcedure
    .input(z.object({ taskId: z.string(), tagIds: z.array(z.string()) }))
    .mutation(async ({ ctx, input }) => {
      // Must await before the trigger fires (and before the mutation resolves) —
      // setTagsForTask writes async; an un-awaited call lets the client refetch
      // before the write lands.
      await setTagsForTask(ctx.db, input.taskId, input.tagIds)
      // Fire the tag-change automation trigger on the engine's bus — mirrors the
      // legacy `ipcMain.emit('db:taskTags:setForTask:done', null, taskId, tagIds)`
      // (tags/electron/handlers.ts). No-op when no started engine listens.
      getTaskTriggerBus()?.emit('db:taskTags:setForTask:done', null, input.taskId, input.tagIds)
      // Only this task's tags changed: every other client patches its row.
      signalTasksChanged([input.taskId])
    })
})

export type TagsRouter = typeof tagsRouter

/**
 * Where this domain's router sits in the app router. `@slayzone/api` mounts
 * `tagsRouter` at `tags` (and asserts the slice in its `router.ts`); the domain's
 * client is typed against exactly this (`client/trpc.ts`).
 */
export type TagsMounts = { tags: TagsRouter }
