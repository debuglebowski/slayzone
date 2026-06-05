import { SkillPreviewDialog } from './SkillPreviewDialog'
import { AddRegistryDialog } from './AddRegistryDialog'
import { RegistryManageSection } from './RegistryManageSection'
import { MarketplaceHeader } from './MarketplaceHeader'
import { MarketplaceRegistryGrid } from './MarketplaceRegistryGrid'
import { MarketplaceSkillGrid } from './MarketplaceSkillGrid'
import { useSkillMarketplace } from './useSkillMarketplace'

interface SkillMarketplaceProps {
  projectId: string | null
  projectPath?: string | null
}

export function SkillMarketplace({ projectId, projectPath }: SkillMarketplaceProps) {
  const m = useSkillMarketplace(projectId, projectPath)

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header — self-rendered, different for drill-in vs list */}
      <MarketplaceHeader
        browseMode={m.browseMode}
        activeRegistry={m.activeRegistry}
        search={m.search}
        setSearch={m.setSearch}
        view={m.view}
        setView={m.setView}
        onDrillOut={m.handleDrillOut}
        onBrowseModeChange={m.handleBrowseModeChange}
        onRefreshAll={m.handleRefreshAll}
        refreshingAll={m.refreshingAll}
        setShowAddDialog={m.setShowAddDialog}
      />

      {/* Body */}
      {m.view === 'manage' ? (
        <RegistryManageSection
          registries={m.registries}
          onToggle={m.handleToggleRegistry}
          onRemove={m.handleRemoveRegistry}
          onRefresh={m.handleRefreshOne}
          refreshingId={m.refreshingId}
        />
      ) : (
        <>
          {/* Registries grid (default view, no drill-in) */}
          {m.browseMode === 'registries' && !m.activeRegistryId && (
            <MarketplaceRegistryGrid registries={m.registries} onDrillIn={m.handleDrillIn} />
          )}

          {/* Skills grid (drill-in or show-all mode) */}
          {m.showSkillGrid && (
            <MarketplaceSkillGrid
              browseMode={m.browseMode}
              search={m.search}
              onSearchChange={m.setSearch}
              selectedRegistry={m.selectedRegistry}
              onSelectedRegistryChange={m.setSelectedRegistry}
              registries={m.registries}
              loading={m.loading}
              entries={m.entries}
              hasProject={m.hasProject}
              installing={m.installing}
              onAddToLibrary={m.handleAddToLibrary}
              onAddToProject={m.handleAddToProject}
              onUpdate={m.handleUpdate}
              onUninstall={m.handleUninstall}
              onPreview={m.setPreviewEntry}
            />
          )}
        </>
      )}

      <SkillPreviewDialog
        entry={m.previewEntry}
        onOpenChange={(open) => !open && m.setPreviewEntry(null)}
        onAddToLibrary={m.handleAddToLibrary}
        onAddToProject={m.handleAddToProject}
        onUpdate={m.handleUpdate}
        onUninstall={m.handleUninstall}
        hasProject={m.hasProject}
        installing={m.previewEntry ? m.installing === m.previewEntry.id : false}
      />

      <AddRegistryDialog
        open={m.showAddDialog}
        onOpenChange={m.setShowAddDialog}
        onAdd={m.handleAddRegistry}
      />
    </div>
  )
}
