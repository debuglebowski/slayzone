import { useAgents } from '@slayzone/terminal'
import { SettingsTabIntro } from './SettingsTabIntro'
import { ProviderListView } from './ai-providers/ProviderListView'
import { ProviderDetailView } from './ai-providers/ProviderDetailView'
import { useAiProviderForm } from './ai-providers/useAiProviderForm'
import { useDefaultAgent } from './use-default-agent'
import { HubWideSection } from '../settings-hub'

interface AiProvidersSettingsTabProps {
  activeTab: string
  navigateTo: (tab: string) => void
}

export function AiProvidersSettingsTab(props: AiProvidersSettingsTabProps) {
  return (
    <>
      <SettingsTabIntro
        title="Providers"
        description="Configure AI coding assistants and custom agents. Each provider can have its own root command and default flags."
      />
      <HubWideSection>
        <Providers {...props} />
      </HubWideSection>
    </>
  )
}

/**
 * Agent definitions, the default agent and per-provider chat defaults all live on a
 * hub and are read by its task create / spawn, so the whole list follows the
 * Settings hub picker (`HubWideSection`).
 */
function Providers({ activeTab, navigateTo }: AiProvidersSettingsTabProps) {
  const {
    modes,
    createMode,
    updateMode,
    deleteMode,
    testMode,
    restoreDefaults,
    resetToDefaultState
  } = useAgents()
  const { defaultAgentId, setDefaultAgentId: onDefaultAgentIdChange } = useDefaultAgent()

  const form = useAiProviderForm({ createMode, testMode })

  return (
    <>
      {activeTab === 'ai-providers' && (
        <ProviderListView
          modes={modes}
          navigateTo={navigateTo}
          updateMode={updateMode}
          restoreDefaults={restoreDefaults}
          resetToDefaultState={resetToDefaultState}
          defaultAgentId={defaultAgentId}
          onDefaultAgentIdChange={onDefaultAgentIdChange}
          form={form}
        />
      )}

      {activeTab.startsWith('ai-providers/') && (
        <ProviderDetailView
          activeTab={activeTab}
          modes={modes}
          navigateTo={navigateTo}
          updateMode={updateMode}
          deleteMode={deleteMode}
          testResults={form.testResults}
          setTestResults={form.setTestResults}
          testingId={form.testingId}
          handleTest={form.handleTest}
        />
      )}
    </>
  )
}
