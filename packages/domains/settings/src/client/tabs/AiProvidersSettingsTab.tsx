import type {
  TerminalMode,
  TerminalModeInfo,
  CreateTerminalModeInput,
  UpdateTerminalModeInput
} from '@slayzone/terminal/shared'
import { SettingsTabIntro } from './SettingsTabIntro'
import { ProviderListView } from './ai-providers/ProviderListView'
import { ProviderDetailView } from './ai-providers/ProviderDetailView'
import { useAiProviderForm } from './ai-providers/useAiProviderForm'

interface AiProvidersSettingsTabProps {
  activeTab: string
  navigateTo: (tab: string) => void
  modes: TerminalModeInfo[]
  createMode: (input: CreateTerminalModeInput) => Promise<TerminalModeInfo>
  updateMode: (id: string, updates: UpdateTerminalModeInput) => Promise<TerminalModeInfo | null>
  deleteMode: (id: string) => Promise<boolean>
  testMode: (command: string) => Promise<{ ok: boolean; error?: string; detail?: string }>
  restoreDefaults: () => Promise<void>
  resetToDefaultState: () => Promise<void>
  defaultTerminalMode: TerminalMode
  onDefaultTerminalModeChange: (mode: TerminalMode) => void
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
    defaultTerminalMode,
    onDefaultTerminalModeChange
  } = props

  const form = useAiProviderForm({ createMode, testMode })

  return (
    <>
      <SettingsTabIntro
        title="Providers"
        description="Configure AI coding assistants and custom terminal modes. Each provider can have its own root command and default flags."
      />

      {activeTab === 'ai-providers' && (
        <ProviderListView
          modes={modes}
          navigateTo={navigateTo}
          updateMode={updateMode}
          restoreDefaults={restoreDefaults}
          resetToDefaultState={resetToDefaultState}
          defaultTerminalMode={defaultTerminalMode}
          onDefaultTerminalModeChange={onDefaultTerminalModeChange}
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
