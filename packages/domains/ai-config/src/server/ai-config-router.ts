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
import { router, publicProcedure } from '@slayzone/trpc-server'
import { aiConfigOpsForComputer, aiConfigOpsForProject } from './ai-config-fs-routing'

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

// Instruction files, skills and MCP config live on a computer: a project's on the
// project's computer (by the checkout path the client names), the computer-level ones
// (`~/.claude`, …) on an explicit `computerId`, else the caller's own. Each procedure
// gets ops over THAT computer's fs (./ai-config-fs-routing.ts); with no computer they
// run on the hub's own disk, refused on a hub with processes off (T-06). DB-only
// procedures (library, selections, providers, marketplace) stay `publicProcedure`.
const projectDiskProcedure = publicProcedure.use(async ({ ctx, path, getRawInput, next }) => {
  const raw = await getRawInput()
  const first = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const aiConfig = await aiConfigOpsForProject(
    ctx.db,
    { projectPath: str(first?.projectPath), projectId: str(first?.projectId) },
    path
  )
  return next({ ctx: { aiConfig } })
})
const computerDiskProcedure = publicProcedure.use(async ({ ctx, path, getRawInput, next }) => {
  const raw = (await getRawInput()) as Record<string, unknown> | undefined
  const computerId = typeof raw?.computerId === 'string' ? raw.computerId : null
  const aiConfig = await aiConfigOpsForComputer(ctx.db, computerId, path)
  return next({ ctx: { aiConfig } })
})
/** A computer-level procedure's input: which computer (default: the caller's own). */
const computerInput = z.object({ computerId: z.string().optional() }).optional()

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
  discoverContextFiles: projectDiskProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(({ ctx, input }) => ctx.aiConfig.discoverContextFiles(input.projectPath)),
  getComputerFiles: computerDiskProcedure
    .input(computerInput)
    .query(({ ctx }) => ctx.aiConfig.getComputerFiles()),
  readContextFile: projectDiskProcedure
    .input(z.object({ filePath: z.string(), projectPath: z.string() }))
    .query(({ ctx, input }) => ctx.aiConfig.readContextFile(input.filePath, input.projectPath)),
  writeContextFile: projectDiskProcedure
    .input(z.object({ filePath: z.string(), content: z.string(), projectPath: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.aiConfig.writeContextFile(input.filePath, input.content, input.projectPath)
    ),
  deleteComputerFile: computerDiskProcedure
    .input(z.object({ filePath: z.string() }))
    .mutation(({ ctx, input }) => ctx.aiConfig.deleteComputerFile(input.filePath)),
  createComputerFile: computerDiskProcedure.input(anyInput).mutation(({ ctx, input }) => {
    const i = input as { provider: string; category: 'skill'; slug: string }
    return ctx.aiConfig.createComputerFile(i.provider, i.category, i.slug)
  }),
  writeComputerSkill: computerDiskProcedure.input(anyInput).mutation(({ ctx, input }) => {
    const i = input as { provider: CliProvider; slug: string; content: string }
    return ctx.aiConfig.writeComputerSkill(i.provider, i.slug, i.content)
  }),
  getContextTree: projectDiskProcedure
    .input(z.object({ projectPath: z.string(), projectId: z.string() }))
    .query(({ ctx, input }) => ctx.aiConfig.getContextTree(input.projectPath, input.projectId)),

  // Library
  loadLibraryItem: projectDiskProcedure
    .input(anyInput)
    .mutation(({ ctx, input }) => ctx.aiConfig.loadLibraryItem(input as LoadLibraryItemInput)),

  // Sync
  syncLinkedFile: projectDiskProcedure
    .input(
      z.object({
        projectId: z.string(),
        projectPath: z.string(),
        itemId: z.string(),
        provider: z.string().optional()
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.aiConfig.syncLinkedFile(
        input.projectId,
        input.projectPath,
        input.itemId,
        input.provider as CliProvider | undefined
      )
    ),
  unlinkFile: publicProcedure
    .input(z.object({ projectId: z.string(), itemId: z.string() }))
    .mutation(({ input }) => getAiConfigOps().unlinkFile(input.projectId, input.itemId)),
  renameContextFile: projectDiskProcedure
    .input(z.object({ oldPath: z.string(), newPath: z.string(), projectPath: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.aiConfig.renameContextFile(input.oldPath, input.newPath, input.projectPath)
    ),
  deleteContextFile: projectDiskProcedure
    .input(z.object({ filePath: z.string(), projectPath: z.string(), projectId: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.aiConfig.deleteContextFile(input.filePath, input.projectPath, input.projectId)
    ),

  // Root instructions
  getRootInstructions: projectDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ ctx, input }) =>
      ctx.aiConfig.getRootInstructions(input.projectId, input.projectPath)
    ),
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
    .mutation(async ({ ctx, input, path }) => {
      // Setting a variant WITH a project path also writes it to the provider files —
      // on the project's computer.
      const ops =
        input.projectPath && input.variantItemId !== null
          ? await aiConfigOpsForProject(ctx.db, input, path)
          : getAiConfigOps()
      return ops.setProjectInstructionVariant(
        input.projectId,
        input.variantItemId,
        input.projectPath
      )
    }),
  saveInstructionsContent: projectDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string(), content: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.aiConfig.saveInstructionsContent(input.projectId, input.projectPath, input.content)
    ),
  saveRootInstructions: projectDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string(), content: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.aiConfig.saveRootInstructions(input.projectId, input.projectPath, input.content)
    ),

  // Provider instructions/skills
  readProviderInstructions: projectDiskProcedure
    .input(z.object({ projectPath: z.string(), provider: z.string() }))
    .query(({ ctx, input }) =>
      ctx.aiConfig.readProviderInstructions(input.projectPath, input.provider as CliProvider)
    ),
  pushProviderInstructions: projectDiskProcedure
    .input(
      z.object({
        projectId: z.string(),
        projectPath: z.string(),
        provider: z.string(),
        content: z.string()
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.aiConfig.pushProviderInstructions(
        input.projectId,
        input.projectPath,
        input.provider as CliProvider,
        input.content
      )
    ),
  pullProviderInstructions: projectDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string(), provider: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.aiConfig.pullProviderInstructions(
        input.projectId,
        input.projectPath,
        input.provider as CliProvider
      )
    ),
  getProjectSkillsStatus: projectDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ ctx, input }) =>
      ctx.aiConfig.getProjectSkillsStatus(input.projectId, input.projectPath)
    ),
  readProviderSkill: projectDiskProcedure
    .input(z.object({ projectPath: z.string(), provider: z.string(), itemId: z.string() }))
    .query(({ ctx, input }) =>
      ctx.aiConfig.readProviderSkill(input.projectPath, input.provider as CliProvider, input.itemId)
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
  pullProviderSkill: projectDiskProcedure
    .input(
      z.object({
        projectId: z.string(),
        projectPath: z.string(),
        provider: z.string(),
        itemId: z.string()
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.aiConfig.pullProviderSkill(
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
  reconcileProjectSkills: projectDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .mutation(({ ctx, input }) =>
      ctx.aiConfig.reconcileProjectSkills(input.projectId, input.projectPath)
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
  needsSync: projectDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ ctx, input }) => ctx.aiConfig.needsSync(input.projectId, input.projectPath)),
  getProjectStaleSkillCount: projectDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ ctx, input }) =>
      ctx.aiConfig.getProjectStaleSkillCount(input.projectId, input.projectPath)
    ),
  // Batch variant of getProjectStaleSkillCount — kept for full IPC parity (ref P15
  // dropped it; we preserve it since the IPC channel is still live for the renderer).
  // Projects may sit on different computers: each counted where its files are.
  getProjectsStaleSkillCounts: publicProcedure
    .input(z.array(z.object({ projectId: z.string(), projectPath: z.string() })))
    .query(async ({ ctx, input, path }) => {
      const out: Record<string, number> = {}
      for (const project of input) {
        const ops = await aiConfigOpsForProject(ctx.db, project, path)
        Object.assign(out, await ops.getProjectsStaleSkillCounts([project]))
      }
      return out
    }),
  syncAll: projectDiskProcedure
    .input(anyInput)
    .mutation(({ ctx, input }) => ctx.aiConfig.syncAll(input as SyncAllInput)),
  checkSyncStatus: projectDiskProcedure
    .input(z.object({ projectId: z.string(), projectPath: z.string() }))
    .query(({ ctx, input }) => ctx.aiConfig.checkSyncStatus(input.projectId, input.projectPath)),

  // MCP
  discoverMcpConfigs: projectDiskProcedure
    .input(z.object({ projectPath: z.string() }))
    .query(({ ctx, input }) => ctx.aiConfig.discoverMcpConfigs(input.projectPath)),
  writeMcpServer: projectDiskProcedure
    .input(anyInput)
    .mutation(({ ctx, input }) => ctx.aiConfig.writeMcpServer(input as WriteMcpServerInput)),
  removeMcpServer: projectDiskProcedure
    .input(anyInput)
    .mutation(({ ctx, input }) => ctx.aiConfig.removeMcpServer(input as RemoveMcpServerInput)),
  discoverComputerMcpConfigs: computerDiskProcedure
    .input(computerInput)
    .query(({ ctx }) => ctx.aiConfig.discoverComputerMcpConfigs()),
  writeComputerMcpServer: computerDiskProcedure
    .input(anyInput)
    .mutation(({ ctx, input }) =>
      ctx.aiConfig.writeComputerMcpServer(input as WriteComputerMcpServerInput)
    ),
  removeComputerMcpServer: computerDiskProcedure
    .input(anyInput)
    .mutation(({ ctx, input }) =>
      ctx.aiConfig.removeComputerMcpServer(input as RemoveComputerMcpServerInput)
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
