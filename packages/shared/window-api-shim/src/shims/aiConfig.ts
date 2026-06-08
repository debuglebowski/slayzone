// cap-migrate-all-tests (Phase 7 Worker AA) —
// aiConfig shim. Routes every window.api.aiConfig.* call through JsonRpcHost
// using the kebab-case `ai-config:*` channel names the sidecar handlers
// register (see packages/domains/ai-config/src/main/handlers.ts). Param
// shape mirrors the Electron preload surface in
// packages/apps/app/src/preload/index.ts — positional args, not wrapped in
// a single object. Positional args are what @slayzone/ai-config/main's
// handlers expect (e.g. `host.handle('ai-config:get-item', (_e, id) => ...)`).
import { jsonRpcCall } from '../transport/mojo'

type Any = unknown

async function invoke<T = Any>(method: string, ...args: unknown[]): Promise<T> {
  // The sidecar dispatcher spreads arrays as positional args, so we pack
  // every caller's args into one. Matches the Electron preload surface
  // (ipcRenderer.invoke(channel, ...args)) exactly.
  return jsonRpcCall<T>(method, args)
}

export const aiConfigShim = {
  listItems: (input: Any) => invoke('ai-config:list-items', input),
  getItem: (id: string) => invoke('ai-config:get-item', id),
  createItem: (input: Any) => invoke('ai-config:create-item', input),
  updateItem: (input: Any) => invoke('ai-config:update-item', input),
  deleteItem: (id: string) => invoke('ai-config:delete-item', id),
  listProjectSelections: (projectId: string) =>
    invoke('ai-config:list-project-selections', projectId),
  setProjectSelection: (input: Any) =>
    invoke('ai-config:set-project-selection', input),
  removeProjectSelection: (projectId: string, itemId: string, provider?: string) =>
    invoke('ai-config:remove-project-selection', projectId, itemId, provider),
  discoverContextFiles: (projectPath: string) =>
    invoke('ai-config:discover-context-files', projectPath),
  readContextFile: (filePath: string, projectPath: string) =>
    invoke('ai-config:read-context-file', filePath, projectPath),
  writeContextFile: (filePath: string, content: string, projectPath: string) =>
    invoke('ai-config:write-context-file', filePath, content, projectPath),
  getContextTree: (projectPath: string, projectId: string) =>
    invoke('ai-config:get-context-tree', projectPath, projectId),
  reconcileProjectSkills: (projectId: string, projectPath: string) =>
    invoke<number>('ai-config:reconcile-project-skills', projectId, projectPath),
  loadLibraryItem: (input: Any) => invoke('ai-config:load-library-item', input),
  syncLinkedFile: (projectId: string, projectPath: string, itemId: string, provider?: string) =>
    invoke('ai-config:sync-linked-file', projectId, projectPath, itemId, provider),
  unlinkFile: (projectId: string, itemId: string) =>
    invoke('ai-config:unlink-file', projectId, itemId),
  renameContextFile: (oldPath: string, newPath: string, projectPath: string) =>
    invoke('ai-config:rename-context-file', oldPath, newPath, projectPath),
  deleteContextFile: (filePath: string, projectPath: string, projectId: string) =>
    invoke('ai-config:delete-context-file', filePath, projectPath, projectId),
  deleteComputerFile: (filePath: string) =>
    invoke('ai-config:delete-computer-file', filePath),
  createComputerFile: (provider: string, category: string, slug: string) =>
    invoke('ai-config:create-computer-file', provider, category, slug),
  writeComputerSkill: (provider: string, slug: string, content: string) =>
    invoke('ai-config:write-computer-skill', provider, slug, content),
  discoverMcpConfigs: (projectPath: string) =>
    invoke('ai-config:discover-mcp-configs', projectPath),
  writeMcpServer: (input: Any) => invoke('ai-config:write-mcp-server', input),
  removeMcpServer: (input: Any) => invoke('ai-config:remove-mcp-server', input),
  discoverComputerMcpConfigs: () => invoke('ai-config:discover-computer-mcp-configs'),
  writeComputerMcpServer: (input: Any) =>
    invoke('ai-config:write-computer-mcp-server', input),
  removeComputerMcpServer: (input: Any) =>
    invoke('ai-config:remove-computer-mcp-server', input),
  listProviders: () => invoke('ai-config:list-providers'),
  toggleProvider: (id: string, enabled: boolean) =>
    invoke('ai-config:toggle-provider', id, enabled),
  getProjectProviders: (projectId: string) =>
    invoke('ai-config:get-project-providers', projectId),
  setProjectProviders: (projectId: string, providers: unknown[]) =>
    invoke('ai-config:set-project-providers', projectId, providers),
  needsSync: (projectId: string, projectPath: string) =>
    invoke('ai-config:needs-sync', projectId, projectPath),
  getProjectStaleSkillCount: (projectId: string, projectPath: string) =>
    invoke('ai-config:get-project-stale-skill-count', projectId, projectPath),
  syncAll: (input: Any) => invoke('ai-config:sync-all', input),
  checkSyncStatus: (projectId: string, projectPath: string) =>
    invoke('ai-config:check-sync-status', projectId, projectPath),
  getLibraryInstructions: (variantId?: string) =>
    invoke('ai-config:get-library-instructions', variantId),
  saveLibraryInstructions: (content: string, variantId?: string) =>
    invoke('ai-config:save-library-instructions', content, variantId),
  listInstructionVariants: () => invoke('ai-config:list-instruction-variants'),
  getProjectInstructionVariant: (projectId: string) =>
    invoke('ai-config:get-project-instruction-variant', projectId),
  setProjectInstructionVariant: (projectId: string, variantItemId: string | null) =>
    invoke('ai-config:set-project-instruction-variant', projectId, variantItemId),
  getRootInstructions: (projectId: string, projectPath: string) =>
    invoke('ai-config:get-root-instructions', projectId, projectPath),
  saveInstructionsContent: (projectId: string, projectPath: string, content: string) =>
    invoke('ai-config:save-instructions-content', projectId, projectPath, content),
  saveRootInstructions: (projectId: string, projectPath: string, content: string) =>
    invoke('ai-config:save-root-instructions', projectId, projectPath, content),
  readProviderInstructions: (projectPath: string, provider: string) =>
    invoke('ai-config:read-provider-instructions', projectPath, provider),
  pushProviderInstructions: (projectId: string, projectPath: string, provider: string, content: string) =>
    invoke('ai-config:push-provider-instructions', projectId, projectPath, provider, content),
  pullProviderInstructions: (projectId: string, projectPath: string, provider: string) =>
    invoke('ai-config:pull-provider-instructions', projectId, projectPath, provider),
  getProjectSkillsStatus: (projectId: string, projectPath: string) =>
    invoke('ai-config:get-project-skills-status', projectId, projectPath),
  readProviderSkill: (projectPath: string, provider: string, itemId: string) =>
    invoke('ai-config:read-provider-skill', projectPath, provider, itemId),
  getExpectedSkillContent: (projectPath: string, provider: string, itemId: string) =>
    invoke('ai-config:get-expected-skill-content', projectPath, provider, itemId),
  pullProviderSkill: (projectId: string, projectPath: string, provider: string, itemId: string) =>
    invoke('ai-config:pull-provider-skill', projectId, projectPath, provider, itemId),
  getComputerFiles: () => invoke('ai-config:get-computer-files'),
  checkSlayConfigured: (projectPath: string) =>
    invoke('ai-config:check-slay-configured', projectPath),
  setupSlay: (projectPath: string, command: string) =>
    invoke('ai-config:setup-slay', projectPath, command),

  marketplace: {
    listRegistries: () => invoke('ai-config:marketplace:list-registries'),
    addRegistry: (input: Any) => invoke('ai-config:marketplace:add-registry', input),
    removeRegistry: (registryId: string) =>
      invoke('ai-config:marketplace:remove-registry', registryId),
    toggleRegistry: (registryId: string, enabled: boolean) =>
      invoke('ai-config:marketplace:toggle-registry', registryId, enabled),
    refreshRegistry: (registryId: string) =>
      invoke('ai-config:marketplace:refresh-registry', registryId),
    refreshAll: () => invoke('ai-config:marketplace:refresh-all'),
    listEntries: (input?: Any) => invoke('ai-config:marketplace:list-entries', input),
    installSkill: (input: Any) => invoke('ai-config:marketplace:install-skill', input),
    checkUpdates: () => invoke('ai-config:marketplace:check-updates'),
    updateSkill: (itemId: string, entryId: string) =>
      invoke('ai-config:marketplace:update-skill', itemId, entryId),
    unlinkSkill: (itemId: string) => invoke('ai-config:marketplace:unlink-skill', itemId),
    ensureFresh: () => invoke('ai-config:marketplace:ensure-fresh'),
  },
}
