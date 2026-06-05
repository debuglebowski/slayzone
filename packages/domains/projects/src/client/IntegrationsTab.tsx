import { ArrowLeft } from 'lucide-react'
import { Switch } from '@slayzone/ui'
import { ProjectIntegrationConnectionModal } from './ProjectIntegrationConnectionModal'
import { SettingsTabIntro } from './project-settings-shared'
import type { IntegrationsTabProps } from './IntegrationsTab.types'
import { useIntegrationsTab } from './useIntegrationsTab'
import { IntegrationCategoryGrid } from './IntegrationCategoryGrid'
import { IntegrationContinuousSyncSection } from './IntegrationContinuousSyncSection'
import { IntegrationGithubImportSection } from './IntegrationGithubImportSection'
import { IntegrationLinearImportSection } from './IntegrationLinearImportSection'

export function IntegrationsTab(props: IntegrationsTabProps) {
  const vm = useIntegrationsTab(props)
  const {
    selectedIntegrationEntry,
    selectedIntegrationViewMeta,
    isGithubContinuousView,
    isLinearContinuousView,
    isGithubImportView,
    isLinearImportView,
    syncAllStepsComplete,
    syncSetupProvider,
    githubSyncEnabled,
    linearSyncEnabled,
    switchingProvider,
    savingSyncProvider,
    handleSaveGithubSyncSettings,
    handleSaveLinearSyncSettings,
    handleDisableSyncForProvider,
    setSelectedIntegrationEntry,
    setSelectedIntegrationMode,
    connectionModalState,
    setConnectionModalState,
    project,
    githubProjectConnectionId,
    linearProjectConnectionId,
    reloadIntegrationState
  } = vm

  return (
    <div className="w-full space-y-6">
      <SettingsTabIntro
        title="Integrations"
        description="Choose one integration path, then configure its project-specific connection and mapping."
      />
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
        <p className="text-xs text-amber-400">
          Integrations are in beta. Use at your own risk. We recommend starting with one-way sync
          before enabling two-way sync.
        </p>
      </div>

      {selectedIntegrationEntry === null ? (
        <IntegrationCategoryGrid vm={vm} />
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => {
                setSelectedIntegrationEntry(null)
                setSelectedIntegrationMode(null)
              }}
              className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              {selectedIntegrationViewMeta.title}
            </button>
            {(isGithubContinuousView || isLinearContinuousView) && syncAllStepsComplete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Sync enabled</span>
                <Switch
                  id="sync-enabled-header-toggle"
                  checked={syncSetupProvider === 'github' ? githubSyncEnabled : linearSyncEnabled}
                  disabled={switchingProvider || savingSyncProvider !== null}
                  onCheckedChange={(checked) => {
                    if (checked === true) {
                      if (syncSetupProvider === 'github') void handleSaveGithubSyncSettings()
                      else void handleSaveLinearSyncSettings()
                    } else {
                      void handleDisableSyncForProvider(syncSetupProvider!)
                    }
                  }}
                />
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">
                {selectedIntegrationViewMeta.description}
              </span>
            )}
          </div>

          {(isGithubContinuousView || isLinearContinuousView) && syncSetupProvider ? (
            <IntegrationContinuousSyncSection vm={vm} />
          ) : null}

          {isGithubImportView ? <IntegrationGithubImportSection vm={vm} /> : null}

          {isLinearImportView ? <IntegrationLinearImportSection vm={vm} /> : null}
        </div>
      )}

      {connectionModalState ? (
        <ProjectIntegrationConnectionModal
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setConnectionModalState(null)
            }
          }}
          projectId={project.id}
          provider={connectionModalState.provider}
          mode={connectionModalState.mode}
          connectionId={
            connectionModalState.provider === 'github'
              ? githubProjectConnectionId
              : linearProjectConnectionId
          }
          onConnectionsChanged={reloadIntegrationState}
        />
      ) : null}
    </div>
  )
}
