import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import {
  createTabRow,
  splitTabRow,
  listTabsForTask,
  moveTabToGroup,
  updateTab,
  deleteTab,
  ensureMainTab,
  tabsEvents,
  type TabsChangedPayload,
} from '@slayzone/task-terminals/server'
import type { CreateTerminalTabInput, UpdateTerminalTabInput } from '@slayzone/task-terminals/shared'
import { router, publicProcedure } from '../trpc'

const createInput = z.unknown() as unknown as z.ZodType<CreateTerminalTabInput>
const updateInput = z.unknown() as unknown as z.ZodType<UpdateTerminalTabInput>

export const taskTerminalsRouter = router({
  list: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ ctx, input }) => listTabsForTask(ctx.db, input.taskId)),

  create: publicProcedure
    .input(createInput)
    .mutation(({ ctx, input }) => createTabRow(ctx.db, input)),

  split: publicProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(({ ctx, input }) => splitTabRow(ctx.db, input.tabId)),

  moveToGroup: publicProcedure
    .input(z.object({ tabId: z.string(), targetGroupId: z.string().nullable() }))
    .mutation(({ ctx, input }) => moveTabToGroup(ctx.db, input.tabId, input.targetGroupId)),

  update: publicProcedure
    .input(updateInput)
    .mutation(({ ctx, input }) => updateTab(ctx.db, input)),

  delete: publicProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(({ ctx, input }) => deleteTab(ctx.db, input.tabId)),

  ensureMain: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .mutation(({ ctx, input }) => ensureMainTab(ctx.db, input.taskId, input.mode)),

  /**
   * Emits whenever any task's tabs change (create/split/etc.). Renderer
   * subscribers filter by taskId. Replaces the `tabs:changed` IPC broadcast.
   */
  onChanged: publicProcedure.subscription(() =>
    observable<TabsChangedPayload>((emit) => {
      const handler = (payload: TabsChangedPayload): void => {
        emit.next(payload)
      }
      tabsEvents.on('tabs:changed', handler)
      return () => {
        tabsEvents.off('tabs:changed', handler)
      }
    }),
  ),
})
