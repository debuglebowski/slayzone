import { getSlayExecutor } from './slay-executor'
import { z } from 'zod'
import { getAiConfigOps, getMarketplaceOps } from './ai-config-ops'
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
  ListEntriesInput
} from '@slayzone/ai-config/shared'
import { router, publicProcedure, hubLocalProcedure } from '@slayzone/trpc-server'
import { assertHubLocalExecEnabled } from '@slayzone/platform/hub-switch-refusal'

// Mirrors the 54 `ai-config:*` + 12 `ai-config:marketplace:*` IPC handlers
// (ai-config/src/main/handlers.ts + handlers-marketplace.ts). Both call the same
// ops instances (`createAiConfigOps`/`createMarketplaceOps`, built via
// `initAiConfigOps(db)`), so the still-registered IPC handlers and these
// procedures share one implementation while IPC + tRPC coexist (renderer cutover
// is a later slice). Complex payloads carry nested provider configs / sync specs;
// mirror the integrations + automations routers and pass them through unchecked
// (the still-live IPC path is validated by TypeScript only). superjson handles
// serialization end-to-end.
const anyInput = z.unknown()

// Reads or writes instruction files, skills or MCP config on the hub's OWN disk (the
// project folder the client names, or the hub process's home). Refused up front on a
// hub with processes off (T-06), like the git panel. DB-only procedures (library,
// selections, providers, marketplace) stay `publicProcedure`.
const hubDiskProcedure = hubLocalProcedure

export const aiConfigRouter = router({
  // Items
  listItems: publicProcedure
    .input(anyInput)
    .query(({ input }) => getAiConfigOps().listItems(input as ListAiConfigItemsInput)),
  getItem: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => getAiConfigOps().getItem(input.id)),
  createItem: publicProcedure
    .input(anyInput)
    .mutation(({ input }) => getAiConfigOps().createItem(input as CreateAiConfigItemInput)),
  updateItem: publicProcedure
    .input(anyInput)
    .mutation(({ input }) => getAiConfigOps().updateItem(input as UpdateAiConfigItemInput)),
  deleteItem: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => getAiConfigOps().deleteItem(input.id)),

  // Project selections
  listProjectSelections: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => getAiConfigOps().listProjectSelections(input.projectId)),
  setProjectSelection: publicProcedure
    .input(anyInput)
    .mutation(({ input }) =>
      getAiConfigOps().setProjectSelection(input as SetAiConfigProjectSelectionInput)
    ),
  removeProjectSelection: publicProcedure
    .input(z.object({ projectId: z.string(), itemId: z.string(), provider: z.string().optional() }))
    .mutation(({ input }) =>
      getAiConfigOps().removeProjectSelection(input.projectId, input.itemId, input.provider)
    ),

  // Context files
  discoverContextFiles: hubDiskProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().discoverContextFiles(input.projectPath)),
  getComputerFiles: hubDiskProcedure.query(() => getAiConfigOps().getComputerFiles()),
  readContextFile: hubDiskProcedure
    .input(z.object({ filePath: z.string(), projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().readContextFile(input.filePath, input.projectPath)),
  writeContextFile: hubDiskProcedure
    .input(z.object({ filePath: z.string(), content: z.string(), projectPath: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().writeContextFile(input.filePath, input.content, input.projectPath)
    ),
  deleteComputerFile: hubDiskProcedure
    .input(z.object({ filePath: z.string() }))
    .mutation(({ input }) => getAiConfigOps().deleteComputerFile(input.filePath)),
  createComputerFile: hubDiskProcedure.input(anyInput).mutation(({ input }) => {
    const i = input as { provider: string; category: 'skill'; slug: string }
    return getAiConfigOps().createComputerFile(i.provider, i.category, i.slug)
  }),
  writeComputerSkill: hubDiskProcedure.input(anyInput).mutation(({ input }) => {
    const i = input as { provider: CliProvider; slug: string; content: string }
    return getAiConfigOps().writeComputerSkill(i.provider, i.slug, i.content)
  }),
  getContextTree: hubDiskProcedure
    .input(z.object({ projectPath: z.string(), projectId: z.string() }))
    .query(({ input }) => getAiConfigOps().getContextTree(input.projectPath, input.projectId)),

  // Library
  loadLibraryItem: hubDiskProcedure
    .input(anyInput)
    .mutation(({ input }) => getAiConfigOps().loadLibraryItem(input as LoadLibraryItemInput)),

  // Sync
  syncLinkedFile: hubDiskProcedure
    .input(
      z.object({
        projectId: z.string(),
        projectPath: z.string(),
        itemId: z.string(),
        provider: z.string().optional()
      })
    )
    .mutation(({ input }) =>
      getAiConfigOps().syncLinkedFile(
        input.projectId,
        input.projectPath,
        input.itemId,
        input.provider as CliProvider | undefined
      )
    ),
  unlinkFile: publicProcedure
    .input(z.object({ projectId: z.string(), itemId: z.string() }))
    .mutation(({ input }) => getAiConfigOps().unlinkFile(input.projectId, input.itemId)),
  renameContextFile: hubDiskProcedure
    .input(z.object({ oldPath: z.string(), newPath: z.string(), projectPath: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().renameContextFile(input.oldPath, input.newPath, input.projectPath)
    ),
  deleteContextFile: hubDiskProcedure
    .input(z.object({ filePath: z.string(), projectPath: z.string(), projectId: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().deleteContextFile(input.filePath, input.projectPath, input.projectId)
    ),

  // Root instructions
  getRootInstructions: hubDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().getRootInstructions(input.projectId, input.projectPath)),
  getLibraryInstructions: publicProcedure
    .input(z.object({ variantId: z.string().optional() }).optional())
    .query(({ input }) => getAiConfigOps().getLibraryInstructions(input?.variantId)),
  saveLibraryInstructions: publicProcedure
    .input(z.object({ content: z.string(), variantId: z.string().optional() }))
    .mutation(({ input }) =>
      getAiConfigOps().saveLibraryInstructions(input.content, input.variantId)
    ),
  listInstructionVariants: publicProcedure.query(() => getAiConfigOps().listInstructionVariants()),
  getProjectInstructionVariant: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => getAiConfigOps().getProjectInstructionVariant(input.projectId)),
  setProjectInstructionVariant: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        variantItemId: z.string().nullable(),
        projectPath: z.string().optional()
      })
    )
    .mutation(({ input, path }) => {
      // Setting a variant WITH a project path also writes it to the provider files.
      if (input.projectPath && input.variantItemId !== null) assertHubLocalExecEnabled({ op: path })
      return getAiConfigOps().setProjectInstructionVariant(
        input.projectId,
        input.variantItemId,
        input.projectPath
      )
    }),
  saveInstructionsContent: hubDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string(), content: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().saveInstructionsContent(input.projectId, input.projectPath, input.content)
    ),
  saveRootInstructions: hubDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string(), content: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().saveRootInstructions(input.projectId, input.projectPath, input.content)
    ),

  // Provider instructions/skills
  readProviderInstructions: hubDiskProcedure
    .input(z.object({ projectPath: z.string(), provider: z.string() }))
    .query(({ input }) =>
      getAiConfigOps().readProviderInstructions(input.projectPath, input.provider as CliProvider)
    ),
  pushProviderInstructions: hubDiskProcedure
    .input(
      z.object({
        projectId: z.string(),
        projectPath: z.string(),
        provider: z.string(),
        content: z.string()
      })
    )
    .mutation(({ input }) =>
      getAiConfigOps().pushProviderInstructions(
        input.projectId,
        input.projectPath,
        input.provider as CliProvider,
        input.content
      )
    ),
  pullProviderInstructions: hubDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string(), provider: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().pullProviderInstructions(
        input.projectId,
        input.projectPath,
        input.provider as CliProvider
      )
    ),
  getProjectSkillsStatus: hubDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ input }) =>
      getAiConfigOps().getProjectSkillsStatus(input.projectId, input.projectPath)
    ),
  readProviderSkill: hubDiskProcedure
    .input(z.object({ projectPath: z.string(), provider: z.string(), itemId: z.string() }))
    .query(({ input }) =>
      getAiConfigOps().readProviderSkill(
        input.projectPath,
        input.provider as CliProvider,
        input.itemId
      )
    ),
  getExpectedSkillContent: publicProcedure
    .input(z.object({ projectPath: z.string(), provider: z.string(), itemId: z.string() }))
    .query(({ input }) =>
      getAiConfigOps().getExpectedSkillContent(
        input.projectPath,
        input.provider as CliProvider,
        input.itemId
      )
    ),
  pullProviderSkill: hubDiskProcedure
    .input(
      z.object({
        projectId: z.string(),
        projectPath: z.string(),
        provider: z.string(),
        itemId: z.string()
      })
    )
    .mutation(({ input }) =>
      getAiConfigOps().pullProviderSkill(
        input.projectId,
        input.projectPath,
        input.provider as CliProvider,
        input.itemId
      )
    ),

  // Providers
  listProviders: publicProcedure.query(() => getAiConfigOps().listProviders()),
  toggleProvider: publicProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(({ input }) => getAiConfigOps().toggleProvider(input.id, input.enabled)),
  reconcileProjectSkills: hubDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .mutation(({ input }) =>
      getAiConfigOps().reconcileProjectSkills(input.projectId, input.projectPath)
    ),
  getProjectProviders: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(({ input }) => getAiConfigOps().getProjectProviders(input.projectId)),
  setProjectProviders: publicProcedure
    .input(z.object({ projectId: z.string(), providers: z.array(z.string()) }))
    .mutation(({ input }) =>
      getAiConfigOps().setProjectProviders(input.projectId, input.providers as CliProvider[])
    ),

  // Sync status
  needsSync: hubDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().needsSync(input.projectId, input.projectPath)),
  getProjectStaleSkillCount: hubDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ input }) =>
      getAiConfigOps().getProjectStaleSkillCount(input.projectId, input.projectPath)
    ),
  // Batch variant of getProjectStaleSkillCount — kept for full IPC parity (ref P15
  // dropped it; we preserve it since the IPC channel is still live for the renderer).
  getProjectsStaleSkillCounts: hubDiskProcedure
    .input(z.array(z.object({ projectId: z.string(), projectPath: z.string() })))
    .query(({ input }) => getAiConfigOps().getProjectsStaleSkillCounts(input)),
  syncAll: hubDiskProcedure
    .input(anyInput)
    .mutation(({ input }) => getAiConfigOps().syncAll(input as SyncAllInput)),
  checkSyncStatus: hubDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().checkSyncStatus(input.projectId, input.projectPath)),

  // MCP
  discoverMcpConfigs: hubDiskProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(({ input }) => getAiConfigOps().discoverMcpConfigs(input.projectPath)),
  writeMcpServer: hubDiskProcedure
    .input(anyInput)
    .mutation(({ input }) => getAiConfigOps().writeMcpServer(input as WriteMcpServerInput)),
  removeMcpServer: hubDiskProcedure
    .input(anyInput)
    .mutation(({ input }) => getAiConfigOps().removeMcpServer(input as RemoveMcpServerInput)),
  discoverComputerMcpConfigs: hubDiskProcedure.query(() =>
    getAiConfigOps().discoverComputerMcpConfigs()
  ),
  writeComputerMcpServer: hubDiskProcedure
    .input(anyInput)
    .mutation(({ input }) =>
      getAiConfigOps().writeComputerMcpServer(input as WriteComputerMcpServerInput)
    ),
  removeComputerMcpServer: hubDiskProcedure
    .input(anyInput)
    .mutation(({ input }) =>
      getAiConfigOps().removeComputerMcpServer(input as RemoveComputerMcpServerInput)
    ),

  // Slay
  checkSlayConfigured: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        projectId: z.string().optional(),
        taskId: z.string().optional()
      })
    )
    .query(({ input }) => getSlayExecutor().checkConfigured(input)),
  setupSlay: publicProcedure
    .input(
      z.object({
        projectPath: z.string(),
        projectId: z.string().optional(),
        taskId: z.string().optional()
      })
    )
    .mutation(({ input }) => getSlayExecutor().setup(input)),

  // Marketplace
  marketplace: router({
    listRegistries: publicProcedure.query(() => getMarketplaceOps().listRegistries()),
    addRegistry: publicProcedure
      .input(anyInput)
      .mutation(({ input }) => getMarketplaceOps().addRegistry(input as AddRegistryInput)),
    removeRegistry: publicProcedure
      .input(z.object({ registryId: z.string() }))
      .mutation(({ input }) => getMarketplaceOps().removeRegistry(input.registryId)),
    toggleRegistry: publicProcedure
      .input(z.object({ registryId: z.string(), enabled: z.boolean() }))
      .mutation(({ input }) => getMarketplaceOps().toggleRegistry(input.registryId, input.enabled)),
    ensureFresh: publicProcedure.mutation(() => getMarketplaceOps().ensureFresh()),
    refreshRegistry: publicProcedure
      .input(z.object({ registryId: z.string() }))
      .mutation(({ input }) => getMarketplaceOps().refreshRegistry(input.registryId)),
    refreshAll: publicProcedure.mutation(() => getMarketplaceOps().refreshAll()),
    listEntries: publicProcedure
      .input(anyInput.optional())
      .query(({ input }) => getMarketplaceOps().listEntries(input as ListEntriesInput | undefined)),
    installSkill: publicProcedure
      .input(anyInput)
      .mutation(({ input }) => getMarketplaceOps().installSkill(input as InstallSkillInput)),
    checkUpdates: publicProcedure.query(() => getMarketplaceOps().checkUpdates()),
    unlinkSkill: publicProcedure
      .input(z.object({ itemId: z.string() }))
      .mutation(({ input }) => getMarketplaceOps().unlinkSkill(input.itemId)),
    updateSkill: publicProcedure
      .input(z.object({ itemId: z.string(), entryId: z.string() }))
      .mutation(({ input }) => getMarketplaceOps().updateSkill(input.itemId, input.entryId))
  })
})

export type AiConfigRouter = typeof aiConfigRouter

/** Where `@slayzone/api` mounts this router; it asserts the slice in its `router.ts`. */
export type AiConfigMounts = { aiConfig: AiConfigRouter }
