import { z } from 'zod'
import {
  scanTestFiles,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  reorderCategories,
  listProfiles,
  saveProfile,
  deleteProfile,
  applyProfile,
  listLabels,
  createLabel,
  updateLabel,
  deleteLabel,
  listFileLabels,
  listFileNotes,
  setFileNote,
  toggleFileLabel
} from '@slayzone/test-panel/server'
import type {
  CreateTestCategoryInput,
  UpdateTestCategoryInput,
  TestProfile,
  CreateTestLabelInput,
  UpdateTestLabelInput
} from '@slayzone/test-panel/shared'
import { router, publicProcedure } from '../trpc'

// Mirrors the 18 `db:testPanel:*` IPC handlers (test-panel/src/main/handlers.ts).
// Both call the same electron-free store (@slayzone/test-panel/server), so the
// still-registered IPC handlers and these procedures share one implementation
// while IPC + tRPC coexist. Renderer cutover + handler deletion are a later slice.
//
// The create/update/profile shapes pass through unchecked (mirror the
// diagnostics/automations routers — the still-live IPC path validates by
// TypeScript only). Mutations return the store promise so the async DB write is
// awaited before the response is sent.
const createCategoryInput = z.unknown() as unknown as z.ZodType<CreateTestCategoryInput>
const updateCategoryInput = z.unknown() as unknown as z.ZodType<UpdateTestCategoryInput>
const profileInput = z.unknown() as unknown as z.ZodType<TestProfile>
const createLabelInput = z.unknown() as unknown as z.ZodType<CreateTestLabelInput>
const updateLabelInput = z.unknown() as unknown as z.ZodType<UpdateTestLabelInput>

export const testPanelRouter = router({
  // Categories CRUD
  getCategories: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) => listCategories(ctx.db, input.projectId)),

  createCategory: publicProcedure
    .input(createCategoryInput)
    .mutation(({ ctx, input }) => createCategory(ctx.db, input)),

  updateCategory: publicProcedure
    .input(updateCategoryInput)
    .mutation(({ ctx, input }) => updateCategory(ctx.db, input)),

  deleteCategory: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deleteCategory(ctx.db, input.id)),

  reorderCategories: publicProcedure
    .input(z.object({ ids: z.array(z.string()) }))
    .mutation(({ ctx, input }) => reorderCategories(ctx.db, input.ids)),

  // Profiles
  getProfiles: publicProcedure.query(({ ctx }) => listProfiles(ctx.db)),

  saveProfile: publicProcedure
    .input(profileInput)
    .mutation(({ ctx, input }) => saveProfile(ctx.db, input)),

  deleteProfile: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deleteProfile(ctx.db, input.id)),

  applyProfile: publicProcedure
    .input(z.object({ projectId: z.string(), profileId: z.string() }))
    .mutation(({ ctx, input }) => applyProfile(ctx.db, input.projectId, input.profileId)),

  // File scanning
  scanFiles: publicProcedure
    .input(z.object({ projectPath: z.string(), projectId: z.string() }))
    .query(async ({ ctx, input }) => {
      const categories = await listCategories(ctx.db, input.projectId)
      return scanTestFiles(input.projectPath, categories)
    }),

  // Labels CRUD
  getLabels: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) => listLabels(ctx.db, input.projectId)),

  createLabel: publicProcedure
    .input(createLabelInput)
    .mutation(({ ctx, input }) => createLabel(ctx.db, input)),

  updateLabel: publicProcedure
    .input(updateLabelInput)
    .mutation(({ ctx, input }) => updateLabel(ctx.db, input)),

  deleteLabel: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => deleteLabel(ctx.db, input.id)),

  // File label assignments + notes
  getFileLabels: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) => listFileLabels(ctx.db, input.projectId)),

  toggleFileLabel: publicProcedure
    .input(z.object({ projectId: z.string(), filePath: z.string(), labelId: z.string() }))
    .mutation(({ ctx, input }) => toggleFileLabel(ctx.db, input.projectId, input.filePath, input.labelId)),

  getFileNotes: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) => listFileNotes(ctx.db, input.projectId)),

  setFileNote: publicProcedure
    .input(z.object({ projectId: z.string(), filePath: z.string(), note: z.string() }))
    .mutation(({ ctx, input }) => setFileNote(ctx.db, input.projectId, input.filePath, input.note))
})
