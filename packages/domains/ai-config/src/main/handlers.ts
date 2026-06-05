import type { IpcMain } from 'electron'
import type { SlayzoneDb } from '@slayzone/platform'
import { initAiConfigOps } from '../server'
import { registerMarketplaceHandlers } from './handlers-marketplace'

/**
 * IPC surface for the ai-config domain. Every channel delegates to the shared
 * ops factory (`createAiConfigOps`, in `../server/handlers-store`) so these
 * handlers and the tRPC `aiConfigRouter` call one implementation while IPC +
 * tRPC coexist (renderer cutover + IPC deletion is a later slice). Args cross
 * the IPC boundary as `any`; the typed ops methods validate via TypeScript.
 */
export function registerAiConfigHandlers(ipcMain: IpcMain, db: SlayzoneDb): void {
  const { ai, market } = initAiConfigOps(db)

  ipcMain.handle('ai-config:list-items', (_e, input) => ai.listItems(input))
  ipcMain.handle('ai-config:get-item', (_e, id) => ai.getItem(id))
  ipcMain.handle('ai-config:create-item', (_e, input) => ai.createItem(input))
  ipcMain.handle('ai-config:update-item', (_e, input) => ai.updateItem(input))
  ipcMain.handle('ai-config:delete-item', (_e, id) => ai.deleteItem(id))
  ipcMain.handle('ai-config:list-project-selections', (_e, projectId) =>
    ai.listProjectSelections(projectId)
  )
  ipcMain.handle('ai-config:set-project-selection', (_e, input) => ai.setProjectSelection(input))
  ipcMain.handle('ai-config:remove-project-selection', (_e, projectId, itemId, provider) =>
    ai.removeProjectSelection(projectId, itemId, provider)
  )
  ipcMain.handle('ai-config:discover-context-files', (_e, projectPath) =>
    ai.discoverContextFiles(projectPath)
  )
  ipcMain.handle('ai-config:get-computer-files', (_e) => ai.getComputerFiles())
  ipcMain.handle('ai-config:read-context-file', (_e, filePath, projectPath) =>
    ai.readContextFile(filePath, projectPath)
  )
  ipcMain.handle('ai-config:write-context-file', (_e, filePath, content, projectPath) =>
    ai.writeContextFile(filePath, content, projectPath)
  )
  ipcMain.handle('ai-config:delete-computer-file', (_e, filePath) =>
    ai.deleteComputerFile(filePath)
  )
  ipcMain.handle('ai-config:create-computer-file', (_e, provider, category, slugInput) =>
    ai.createComputerFile(provider, category, slugInput)
  )
  ipcMain.handle('ai-config:write-computer-skill', (_e, provider, slug, content) =>
    ai.writeComputerSkill(provider, slug, content)
  )
  ipcMain.handle('ai-config:get-context-tree', (_e, projectPath, projectId) =>
    ai.getContextTree(projectPath, projectId)
  )
  ipcMain.handle('ai-config:load-library-item', (_e, input) => ai.loadLibraryItem(input))
  ipcMain.handle('ai-config:sync-linked-file', (_e, projectId, projectPath, itemId, provider) =>
    ai.syncLinkedFile(projectId, projectPath, itemId, provider)
  )
  ipcMain.handle('ai-config:unlink-file', (_e, projectId, itemId) =>
    ai.unlinkFile(projectId, itemId)
  )
  ipcMain.handle('ai-config:rename-context-file', (_e, oldPath, newPath, projectPath) =>
    ai.renameContextFile(oldPath, newPath, projectPath)
  )
  ipcMain.handle('ai-config:delete-context-file', (_e, filePath, projectPath, projectId) =>
    ai.deleteContextFile(filePath, projectPath, projectId)
  )
  ipcMain.handle('ai-config:get-root-instructions', (_e, projectId, projectPath) =>
    ai.getRootInstructions(projectId, projectPath)
  )
  ipcMain.handle('ai-config:get-library-instructions', (_e, variantId) =>
    ai.getLibraryInstructions(variantId)
  )
  ipcMain.handle('ai-config:save-library-instructions', (_e, content, variantId) =>
    ai.saveLibraryInstructions(content, variantId)
  )
  ipcMain.handle('ai-config:list-instruction-variants', (_e) => ai.listInstructionVariants())
  ipcMain.handle('ai-config:get-project-instruction-variant', (_e, projectId) =>
    ai.getProjectInstructionVariant(projectId)
  )
  ipcMain.handle(
    'ai-config:set-project-instruction-variant',
    (_e, projectId, variantItemId, projectPath) =>
      ai.setProjectInstructionVariant(projectId, variantItemId, projectPath)
  )
  ipcMain.handle('ai-config:save-instructions-content', (_e, projectId, projectPath, content) =>
    ai.saveInstructionsContent(projectId, projectPath, content)
  )
  ipcMain.handle('ai-config:save-root-instructions', (_e, projectId, projectPath, content) =>
    ai.saveRootInstructions(projectId, projectPath, content)
  )
  ipcMain.handle('ai-config:read-provider-instructions', (_e, projectPath, provider) =>
    ai.readProviderInstructions(projectPath, provider)
  )
  ipcMain.handle(
    'ai-config:push-provider-instructions',
    (_e, projectId, projectPath, provider, content) =>
      ai.pushProviderInstructions(projectId, projectPath, provider, content)
  )
  ipcMain.handle('ai-config:pull-provider-instructions', (_e, projectId, projectPath, provider) =>
    ai.pullProviderInstructions(projectId, projectPath, provider)
  )
  ipcMain.handle('ai-config:get-project-skills-status', (_e, projectId, projectPath) =>
    ai.getProjectSkillsStatus(projectId, projectPath)
  )
  ipcMain.handle('ai-config:read-provider-skill', (_e, projectPath, provider, itemId) =>
    ai.readProviderSkill(projectPath, provider, itemId)
  )
  ipcMain.handle('ai-config:get-expected-skill-content', (_e, _projectPath, provider, itemId) =>
    ai.getExpectedSkillContent(_projectPath, provider, itemId)
  )
  ipcMain.handle('ai-config:pull-provider-skill', (_e, projectId, projectPath, provider, itemId) =>
    ai.pullProviderSkill(projectId, projectPath, provider, itemId)
  )
  ipcMain.handle('ai-config:list-providers', (_e) => ai.listProviders())
  ipcMain.handle('ai-config:toggle-provider', (_e, id, enabled) => ai.toggleProvider(id, enabled))
  ipcMain.handle('ai-config:reconcile-project-skills', (_e, projectId, projectPath) =>
    ai.reconcileProjectSkills(projectId, projectPath)
  )
  ipcMain.handle('ai-config:get-project-providers', (_e, projectId) =>
    ai.getProjectProviders(projectId)
  )
  ipcMain.handle('ai-config:set-project-providers', (_e, projectId, providers) =>
    ai.setProjectProviders(projectId, providers)
  )
  ipcMain.handle('ai-config:needs-sync', (_e, projectId, projectPath) =>
    ai.needsSync(projectId, projectPath)
  )
  ipcMain.handle('ai-config:get-project-stale-skill-count', (_e, projectId, projectPath) =>
    ai.getProjectStaleSkillCount(projectId, projectPath)
  )
  ipcMain.handle('ai-config:get-projects-stale-skill-counts', (_e, pairs) =>
    ai.getProjectsStaleSkillCounts(pairs)
  )
  ipcMain.handle('ai-config:sync-all', (_e, input) => ai.syncAll(input))
  ipcMain.handle('ai-config:check-sync-status', (_e, projectId, projectPath) =>
    ai.checkSyncStatus(projectId, projectPath)
  )
  ipcMain.handle('ai-config:discover-mcp-configs', (_e, projectPath) =>
    ai.discoverMcpConfigs(projectPath)
  )
  ipcMain.handle('ai-config:write-mcp-server', (_e, input) => ai.writeMcpServer(input))
  ipcMain.handle('ai-config:remove-mcp-server', (_e, input) => ai.removeMcpServer(input))
  ipcMain.handle('ai-config:discover-computer-mcp-configs', (_e) => ai.discoverComputerMcpConfigs())
  ipcMain.handle('ai-config:write-computer-mcp-server', (_e, input) =>
    ai.writeComputerMcpServer(input)
  )
  ipcMain.handle('ai-config:remove-computer-mcp-server', (_e, input) =>
    ai.removeComputerMcpServer(input)
  )
  ipcMain.handle('ai-config:check-slay-configured', (_e, projectPath) =>
    ai.checkSlayConfigured(projectPath)
  )
  ipcMain.handle('ai-config:setup-slay', (_e, projectPath, projectId) =>
    ai.setupSlay(projectPath, projectId)
  )

  // Marketplace handlers (delegate to the same shared ops instance)
  registerMarketplaceHandlers(ipcMain, market)
}
