import type { IpcMain } from 'electron'
import type { MarketplaceOps } from '../server'

/**
 * IPC surface for the ai-config marketplace. Delegates to the shared
 * `MarketplaceOps` instance (built in `../server`) so these handlers and the
 * tRPC `aiConfigRouter.marketplace` sub-router share one implementation while
 * IPC + tRPC coexist (renderer cutover is a later slice).
 */
export function registerMarketplaceHandlers(ipcMain: IpcMain, market: MarketplaceOps): void {
  ipcMain.handle('ai-config:marketplace:list-registries', (_e) => market.listRegistries())
  ipcMain.handle('ai-config:marketplace:add-registry', (_e, input) => market.addRegistry(input))
  ipcMain.handle('ai-config:marketplace:remove-registry', (_e, registryId) =>
    market.removeRegistry(registryId)
  )
  ipcMain.handle('ai-config:marketplace:toggle-registry', (_e, registryId, enabled) =>
    market.toggleRegistry(registryId, enabled)
  )
  ipcMain.handle('ai-config:marketplace:ensure-fresh', (_e) => market.ensureFresh())
  ipcMain.handle('ai-config:marketplace:refresh-registry', (_e, registryId) =>
    market.refreshRegistry(registryId)
  )
  ipcMain.handle('ai-config:marketplace:refresh-all', (_e) => market.refreshAll())
  ipcMain.handle('ai-config:marketplace:list-entries', (_e, input) => market.listEntries(input))
  ipcMain.handle('ai-config:marketplace:install-skill', (_e, input) => market.installSkill(input))
  ipcMain.handle('ai-config:marketplace:check-updates', (_e) => market.checkUpdates())
  ipcMain.handle('ai-config:marketplace:unlink-skill', (_e, itemId) => market.unlinkSkill(itemId))
  ipcMain.handle('ai-config:marketplace:update-skill', (_e, itemId, entryId) =>
    market.updateSkill(itemId, entryId)
  )
}
