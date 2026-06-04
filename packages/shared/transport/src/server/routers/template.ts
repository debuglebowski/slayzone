import { z } from 'zod'
import {
  listTemplatesByProject,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  setDefaultTemplate
} from '@slayzone/task/server'
import type { CreateTaskTemplateInput, UpdateTaskTemplateInput } from '@slayzone/task/shared'
import { router, publicProcedure } from '../trpc'

// Mirrors the 6 `db:taskTemplates:*` IPC handlers (task/src/main/template-handlers.ts).
// The store is electron-free (../../../../domains/task/src/server/template-store) so it's
// imported directly — both IPC + tRPC call one implementation (coexistence until slice 5).
// create/update pass shapes through unchecked (IPC validates by TypeScript only).
const createInput = z.unknown() as unknown as z.ZodType<CreateTaskTemplateInput>
const updateInput = z.unknown() as unknown as z.ZodType<UpdateTaskTemplateInput>

export const templateRouter = router({
  getByProject: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) => listTemplatesByProject(ctx.db, input.projectId)),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => getTemplate(ctx.db, input.id)),

  create: publicProcedure
    .input(createInput)
    .mutation(({ ctx, input }) => createTemplate(ctx.db, input)),

  update: publicProcedure
    .input(updateInput)
    .mutation(({ ctx, input }) => updateTemplate(ctx.db, input)),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deleteTemplate(ctx.db, input.id)),

  setDefault: publicProcedure
    .input(z.object({ projectId: z.string(), templateId: z.string().nullable() }))
    .mutation(({ ctx, input }) => setDefaultTemplate(ctx.db, input.projectId, input.templateId))
})
