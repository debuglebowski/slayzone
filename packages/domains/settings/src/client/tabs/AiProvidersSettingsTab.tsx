import type {
  AgentId,
  AgentDefinition,
  CreateAgentDefinitionInput,
  UpdateAgentDefinitionInput
} from '@slayzone/terminal-contracts'
import { SettingsTabIntro } from './SettingsTabIntro'
import { ProviderListView } from './ai-providers/ProviderListView'
import { ProviderDetailView } from './ai-providers/ProviderDetailView'
import { useAiProviderForm } from './ai-providers/useAiProviderForm'

interface AiProvidersSettingsTabProps {
  activeTab: string
  navigateTo: (tab: string) => void
  modes: AgentDefinition[]
  createMode: (input: CreateAgentDefinitionInput) => Promise<AgentDefinition>
  updateMode: (id: string, updates: UpdateAgentDefinitionInput) => Promise<AgentDefinition | null>
  deleteMode: (id: string) => Promise<boolean>
  testMode: (command: string) => Promise<{ ok: boolean; error?: string; detail?: string }>
  restoreDefaults: () => Promise<void>
  resetToDefaultState: () => Promise<void>
  defaultAgentId: AgentId
  onDefaultAgentIdChange: (mode: AgentId) => void
}

export function AiProvidersSettingsTab(props: AiProvidersSettingsTabProps) {
  const {
    activeTab,
    navigateTo,
    modes,
    createMode,
    updateMode,
    deleteMode,
    testMode,
    restoreDefaults,
    resetToDefaultState,
    defaultAgentId,
    onDefaultAgentIdChange
  } = props

  const form = useAiProviderForm({ createMode, testMode })

  return (
    <>
      <SettingsTabIntro
        title="Providers"
        description="Configure AI coding assistants and custom agents. Each provider can have its own root command and default flags."
      />

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
