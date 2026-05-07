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
  toggleFileLabel,
} from '@slayzone/test-panel/server'
import type {
  CreateTestCategoryInput,
  UpdateTestCategoryInput,
  TestProfile,
  CreateTestLabelInput,
  UpdateTestLabelInput,
  TestCategory,
} from '@slayzone/test-panel/shared'
import { router, publicProcedure } from '../trpc'

const createCategoryInput = z.unknown() as unknown as z.ZodType<CreateTestCategoryInput>
const updateCategoryInput = z.unknown() as unknown as z.ZodType<UpdateTestCategoryInput>
const profileInput = z.unknown() as unknown as z.ZodType<TestProfile>
const createLabelInput = z.unknown() as unknown as z.ZodType<CreateTestLabelInput>
const updateLabelInput = z.unknown() as unknown as z.ZodType<UpdateTestLabelInput>

export const testPanelRouter = router({
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
    .mutation(({ ctx, input }) => {
      reorderCategories(ctx.db, input.ids)
    }),

  getProfiles: publicProcedure.query(({ ctx }) => listProfiles(ctx.db)),

  saveProfile: publicProcedure
    .input(profileInput)
    .mutation(({ ctx, input }) => {
      saveProfile(ctx.db, input)
    }),

  deleteProfile: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      deleteProfile(ctx.db, input.id)
    }),

  applyProfile: publicProcedure
    .input(z.object({ projectId: z.string(), profileId: z.string() }))
    .mutation(({ ctx, input }) => applyProfile(ctx.db, input.projectId, input.profileId)),

  scanFiles: publicProcedure
    .input(z.object({ projectPath: z.string(), projectId: z.string() }))
    .query(({ ctx, input }) => {
      const categories = listCategories(ctx.db, input.projectId) as TestCategory[]
      return scanTestFiles(input.projectPath, categories)
    }),

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

  getFileLabels: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) => listFileLabels(ctx.db, input.projectId)),

  toggleFileLabel: publicProcedure
    .input(z.object({ projectId: z.string(), filePath: z.string(), labelId: z.string() }))
    .mutation(({ ctx, input }) => {
      toggleFileLabel(ctx.db, input.projectId, input.filePath, input.labelId)
    }),

  getFileNotes: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ ctx, input }) => listFileNotes(ctx.db, input.projectId)),

  setFileNote: publicProcedure
    .input(z.object({ projectId: z.string(), filePath: z.string(), note: z.string() }))
    .mutation(({ ctx, input }) => {
      setFileNote(ctx.db, input.projectId, input.filePath, input.note)
    }),
})
