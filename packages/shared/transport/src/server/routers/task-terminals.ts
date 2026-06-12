import { z } from 'zod'
import { observable } from '@trpc/server/observable'
import {
  listTabsForTask,
  createTabRow,
  splitTabRow,
  moveTabToGroup,
  updateTabRow,
  deleteTab,
  ensureMainTab,
  listHibernatedSessionIds,
  tabsEvents,
  type TabsChangedPayload
} from '@slayzone/task-terminals/server'
import type {
  CreateTerminalTabInput,
  UpdateTerminalTabInput
} from '@slayzone/task-terminals/shared'
import { router, publicProcedure } from '../trpc'

// Mirrors the 7 `tabs:*` IPC handlers (task-terminals/src/main/handlers.ts) plus
// the `tabs:changed` broadcast. Both the still-registered IPC handlers and these
// procedures call the same electron-free store (@slayzone/task-terminals/server),
// so IPC + tRPC coexist over one implementation. Renderer cutover + handler
// deletion are a later slice.
//
// create/update pass their shapes through unchecked (mirror the diagnostics /
// test-panel routers — the still-live IPC path validates by TypeScript only).
const createInput = z.unknown() as unknown as z.ZodType<CreateTerminalTabInput>
const updateInput = z.unknown() as unknown as z.ZodType<UpdateTerminalTabInput>

export const taskTerminalsRouter = router({
  list: publicProcedure
    .input(z.object({ taskId: z.string() }))
    .query(({ ctx, input }) => listTabsForTask(ctx.db, input.taskId)),

  /** Main-tab session ids flagged hibernated — seeds the renderer's 💤 dots at boot. */
  listHibernatedSessions: publicProcedure.query(({ ctx }) => listHibernatedSessionIds(ctx.db)),

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
    .mutation(({ ctx, input }) => updateTabRow(ctx.db, input)),

  delete: publicProcedure
    .input(z.object({ tabId: z.string() }))
    .mutation(({ ctx, input }) => deleteTab(ctx.db, input.tabId)),

  ensureMain: publicProcedure
    .input(z.object({ taskId: z.string(), mode: z.string() }))
    .mutation(({ ctx, input }) => ensureMainTab(ctx.db, input.taskId, input.mode)),

  /**
   * Emits whenever any task's tabs change (create/split/rename/cold-start).
   * Renderer subscribers filter by taskId. Replaces the `tabs:changed` IPC
   * broadcast once the renderer cuts over (slice 5).
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
    })
  )
})
