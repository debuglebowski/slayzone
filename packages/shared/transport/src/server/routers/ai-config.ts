import { z } from 'zod'
import { getAiConfigOps, getMarketplaceOps } from '@slayzone/ai-config/server'
import type {
  ListAiConfigItemsInput,
  CreateAiConfigItemInput,
  UpdateAiConfigItemInput,
  SetAiConfigProjectSelectionInput,
  LoadLibraryItemInput,
  SyncAllInput,
  WriteMcpServerInput,
  RemoveMcpServerInput,
  WriteComputerMcpServerInput,
  RemoveComputerMcpServerInput,
  CliProvider,
  AddRegistryInput,
  InstallSkillInput,
  ListEntriesInput,
} from '@slayzone/ai-config/shared'
import { router, publicProcedure } from '../trpc'

// Trust renderer-side TS types — no runtime validation for trusted scope-1.
// When auth lands (master §11b), tighten with strict zod schemas.
const anyInput = z.unknown()

export const aiConfigRouter = router({
  // Items
  listItems: publicProcedure.input(anyInput).query(({ input }) =>
    getAiConfigOps().listItems(input as ListAiConfigItemsInput),
  ),
  getItem: publicProcedure.input(z.object({ id: z.string() })).query(({ input }) =>
    getAiConfigOps().getItem(input.id),
  ),
  createItem: publicProcedure.input(anyInput).mutation(({ input }) =>
    getAiConfigOps().createItem(input as CreateAiConfigItemInput),
  ),
  updateItem: publicProcedure.input(anyInput).mutation(({ input }) =>
    getAiConfigOps().updateItem(input as UpdateAiConfigItemInput),
  ),
  deleteItem: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) =>
    getAiConfigOps().deleteItem(input.id),
  ),

  // Project selections
  listProjectSelections: publicProcedure.input(z.object({ projectId: z.string() })).query(({ input }) =>
    getAiConfigOps().listProjectSelections(input.projectId),
  ),
  setProjectSelection: publicProcedure.input(anyInput).mutation(({ input }) =>
    getAiConfigOps().setProjectSelection(input as SetAiConfigProjectSelectionInput),
  ),
  removeProjectSelection: publicProcedure
    .input(z.object({ projectId: z.string(), itemId: z.string(), provider: z.string().optional() }))
    .mutation(({ input }) =>
      getAiConfigOps().removeProjectSelection(input.projectId, input.itemId, input.provider),
    ),

  // Context files
  discoverContextFiles: publicProcedure.input(z.object({ projectPath: z.string() })).query(({ input }) =>
    getAiConfigOps().discoverContextFiles(input.projectPath),
  ),
  getComputerFiles: publicProcedure.query(() => getAiConfigOps().getComputerFiles()),
  readContextFile: publicProcedure
    .input(z.object({ filePath: z.string(), projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().readContextFile(input.filePath, input.projectPath)),
  writeContextFile: publicProcedure
    .input(z.object({ filePath: z.string(), content: z.string(), projectPath: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().writeContextFile(input.filePath, input.content, input.projectPath),
    ),
  deleteComputerFile: publicProcedure.input(z.object({ filePath: z.string() })).mutation(({ input }) =>
    getAiConfigOps().deleteComputerFile(input.filePath),
  ),
  createComputerFile: publicProcedure.input(anyInput).mutation(({ input }) => {
    const i = input as { provider: string; category: 'skill'; slug: string }
    return getAiConfigOps().createComputerFile(i.provider, i.category, i.slug)
  }),
  writeComputerSkill: publicProcedure.input(anyInput).mutation(({ input }) => {
    const i = input as { provider: CliProvider; slug: string; content: string }
    return getAiConfigOps().writeComputerSkill(i.provider, i.slug, i.content)
  }),
  getContextTree: publicProcedure
    .input(z.object({ projectPath: z.string(), projectId: z.string() }))
    .query(({ input }) => getAiConfigOps().getContextTree(input.projectPath, input.projectId)),

  // Library
  loadLibraryItem: publicProcedure.input(anyInput).mutation(({ input }) =>
    getAiConfigOps().loadLibraryItem(input as LoadLibraryItemInput),
  ),

  // Sync
  syncLinkedFile: publicProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string(), itemId: z.string(), provider: z.string().optional() }))
    .mutation(({ input }) =>
      getAiConfigOps().syncLinkedFile(input.projectId, input.projectPath, input.itemId, input.provider as CliProvider | undefined),
    ),
  unlinkFile: publicProcedure
    .input(z.object({ projectId: z.string(), itemId: z.string() }))
    .mutation(({ input }) => getAiConfigOps().unlinkFile(input.projectId, input.itemId)),
  renameContextFile: publicProcedure
    .input(z.object({ oldPath: z.string(), newPath: z.string(), projectPath: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().renameContextFile(input.oldPath, input.newPath, input.projectPath),
    ),
  deleteContextFile: publicProcedure
    .input(z.object({ filePath: z.string(), projectPath: z.string(), projectId: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().deleteContextFile(input.filePath, input.projectPath, input.projectId),
    ),

  // Root instructions
  getRootInstructions: publicProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().getRootInstructions(input.projectId, input.projectPath)),
  getLibraryInstructions: publicProcedure
    .input(z.object({ variantId: z.string().optional() }).optional())
    .query(({ input }) => getAiConfigOps().getLibraryInstructions(input?.variantId)),
  saveLibraryInstructions: publicProcedure
    .input(z.object({ content: z.string(), variantId: z.string().optional() }))
    .mutation(({ input }) => getAiConfigOps().saveLibraryInstructions(input.content, input.variantId)),
  listInstructionVariants: publicProcedure.query(() => getAiConfigOps().listInstructionVariants()),
  getProjectInstructionVariant: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => getAiConfigOps().getProjectInstructionVariant(input.projectId)),
  setProjectInstructionVariant: publicProcedure
    .input(z.object({
      projectId: z.string(),
      variantItemId: z.string().nullable(),
      projectPath: z.string().optional(),
    }))
    .mutation(({ input }) =>
      getAiConfigOps().setProjectInstructionVariant(input.projectId, input.variantItemId, input.projectPath),
    ),
  saveInstructionsContent: publicProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string(), content: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().saveInstructionsContent(input.projectId, input.projectPath, input.content),
    ),
  saveRootInstructions: publicProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string(), content: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().saveRootInstructions(input.projectId, input.projectPath, input.content),
    ),

  // Provider instructions/skills
  readProviderInstructions: publicProcedure
    .input(z.object({ projectPath: z.string(), provider: z.string() }))
    .query(({ input }) =>
      getAiConfigOps().readProviderInstructions(input.projectPath, input.provider as CliProvider),
    ),
  pushProviderInstructions: publicProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string(), provider: z.string(), content: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().pushProviderInstructions(input.projectId, input.projectPath, input.provider as CliProvider, input.content),
    ),
  pullProviderInstructions: publicProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string(), provider: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().pullProviderInstructions(input.projectId, input.projectPath, input.provider as CliProvider),
    ),
  getProjectSkillsStatus: publicProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().getProjectSkillsStatus(input.projectId, input.projectPath)),
  readProviderSkill: publicProcedure
    .input(z.object({ projectPath: z.string(), provider: z.string(), itemId: z.string() }))
    .query(({ input }) =>
      getAiConfigOps().readProviderSkill(input.projectPath, input.provider as CliProvider, input.itemId),
    ),
  getExpectedSkillContent: publicProcedure
    .input(z.object({ projectPath: z.string(), provider: z.string(), itemId: z.string() }))
    .query(({ input }) =>
      getAiConfigOps().getExpectedSkillContent(input.projectPath, input.provider as CliProvider, input.itemId),
    ),
  pullProviderSkill: publicProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string(), provider: z.string(), itemId: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().pullProviderSkill(input.projectId, input.projectPath, input.provider as CliProvider, input.itemId),
    ),

  // Providers
  listProviders: publicProcedure.query(() => getAiConfigOps().listProviders()),
  toggleProvider: publicProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(({ input }) => getAiConfigOps().toggleProvider(input.id, input.enabled)),
  reconcileProjectSkills: publicProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .mutation(({ input }) => getAiConfigOps().reconcileProjectSkills(input.projectId, input.projectPath)),
  getProjectProviders: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => getAiConfigOps().getProjectProviders(input.projectId)),
  setProjectProviders: publicProcedure
    .input(z.object({ projectId: z.string(), providers: z.array(z.string()) }))
    .mutation(({ input }) =>
      getAiConfigOps().setProjectProviders(input.projectId, input.providers as CliProvider[]),
    ),

  // Sync status
  needsSync: publicProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().needsSync(input.projectId, input.projectPath)),
  getProjectStaleSkillCount: publicProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().getProjectStaleSkillCount(input.projectId, input.projectPath)),
  syncAll: publicProcedure.input(anyInput).mutation(({ input }) =>
    getAiConfigOps().syncAll(input as SyncAllInput),
  ),
  checkSyncStatus: publicProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().checkSyncStatus(input.projectId, input.projectPath)),

  // MCP
  discoverMcpConfigs: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().discoverMcpConfigs(input.projectPath)),
  writeMcpServer: publicProcedure.input(anyInput).mutation(({ input }) =>
    getAiConfigOps().writeMcpServer(input as WriteMcpServerInput),
  ),
  removeMcpServer: publicProcedure.input(anyInput).mutation(({ input }) =>
    getAiConfigOps().removeMcpServer(input as RemoveMcpServerInput),
  ),
  discoverComputerMcpConfigs: publicProcedure.query(() => getAiConfigOps().discoverComputerMcpConfigs()),
  writeComputerMcpServer: publicProcedure.input(anyInput).mutation(({ input }) =>
    getAiConfigOps().writeComputerMcpServer(input as WriteComputerMcpServerInput),
  ),
  removeComputerMcpServer: publicProcedure.input(anyInput).mutation(({ input }) =>
    getAiConfigOps().removeComputerMcpServer(input as RemoveComputerMcpServerInput),
  ),

  // Slay
  checkSlayConfigured: publicProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().checkSlayConfigured(input.projectPath)),
  setupSlay: publicProcedure
    .input(z.object({ projectPath: z.string(), projectId: z.string().optional() }))
    .mutation(({ input }) => getAiConfigOps().setupSlay(input.projectPath, input.projectId)),

  // Marketplace
  marketplace: router({
    listRegistries: publicProcedure.query(() => getMarketplaceOps().listRegistries()),
    addRegistry: publicProcedure.input(anyInput).mutation(({ input }) =>
      getMarketplaceOps().addRegistry(input as AddRegistryInput),
    ),
    removeRegistry: publicProcedure.input(z.object({ registryId: z.string() })).mutation(({ input }) =>
      getMarketplaceOps().removeRegistry(input.registryId),
    ),
    toggleRegistry: publicProcedure
      .input(z.object({ registryId: z.string(), enabled: z.boolean() }))
      .mutation(({ input }) => getMarketplaceOps().toggleRegistry(input.registryId, input.enabled)),
    ensureFresh: publicProcedure.mutation(() => getMarketplaceOps().ensureFresh()),
    refreshRegistry: publicProcedure
      .input(z.object({ registryId: z.string() }))
      .mutation(({ input }) => getMarketplaceOps().refreshRegistry(input.registryId)),
    refreshAll: publicProcedure.mutation(() => getMarketplaceOps().refreshAll()),
    listEntries: publicProcedure.input(anyInput.optional()).query(({ input }) =>
      getMarketplaceOps().listEntries(input as ListEntriesInput | undefined),
    ),
    installSkill: publicProcedure.input(anyInput).mutation(({ input }) =>
      getMarketplaceOps().installSkill(input as InstallSkillInput),
    ),
    checkUpdates: publicProcedure.query(() => getMarketplaceOps().checkUpdates()),
    unlinkSkill: publicProcedure.input(z.object({ itemId: z.string() })).mutation(({ input }) =>
      getMarketplaceOps().unlinkSkill(input.itemId),
    ),
    updateSkill: publicProcedure
      .input(z.object({ itemId: z.string(), entryId: z.string() }))
      .mutation(({ input }) => getMarketplaceOps().updateSkill(input.itemId, input.entryId)),
  }),
})
