import { useState, useEffect, useCallback } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { XIcon } from 'lucide-react'
import { Dialog, DialogContent, SettingsLayout } from '@slayzone/ui'
import { useTerminalModes } from '@slayzone/terminal'
import type { TerminalMode } from '@slayzone/terminal/shared'
import { useTelemetry, TelemetrySettings } from '@slayzone/telemetry/client'
import type { ContextManagerSection } from '../../../ai-config/src/client/ContextManagerSettings'

// Import autonomous tabs
import { McpSettingsTab } from './tabs/McpSettingsTab'
import { AppearanceSettingsTab } from './tabs/AppearanceSettingsTab'
import { LayoutSettingsTab } from './tabs/LayoutSettingsTab'
import { PanelsSettingsTab } from './tabs/PanelsSettingsTab'
import { AiProvidersSettingsTab } from './tabs/AiProvidersSettingsTab'
import { DataSettingsTab } from './tabs/DataSettingsTab'
import { DiagnosticsSettingsTab } from './tabs/DiagnosticsSettingsTab'
import { AboutSettingsTab } from './tabs/AboutSettingsTab'
import { WorktreesSettingsTab } from './tabs/WorktreesSettingsTab'
import { BackupSettingsTab } from './tabs/BackupSettingsTab'
import { LabsSettingsTab } from './tabs/LabsSettingsTab'
import { ServerSettingsTab } from './tabs/ServerSettingsTab'
import { SettingsTabIntro } from './tabs/SettingsTabIntro'

function TelemetrySettingsTab() {
  const { tier, setTier } = useTelemetry()
  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Telemetry"
        description="Choose what product usage data is collected. Telemetry helps improve reliability while honoring your selected privacy tier."
      />
      <TelemetrySettings tier={tier} onTierChange={setTier} />
    </div>
  )
}

interface UserSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: string
  initialAiConfigSection?: ContextManagerSection | null
  onTabChange?: (tab: string) => void
}

export function UserSettingsDialog({
  open,
  onOpenChange,
  initialTab = 'appearance',
  initialAiConfigSection: _initialAiConfigSection = null,
  onTabChange
}: UserSettingsDialogProps) {
  // Modes list is SHARED because multiple tabs (AI Providers, Panels) need it
  const {
    modes,
    createMode,
    updateMode,
    deleteMode,
    testMode,
    restoreDefaults,
    resetToDefaultState
  } = useTerminalModes()

  const trpc = useTRPC()
  const [activeTab, setActiveTab] = useState(initialTab)
  const [defaultTerminalMode, setDefaultTerminalMode] = useState<TerminalMode>('claude-code')

  const defaultModeQuery = useQuery(
    trpc.settings.get.queryOptions({ key: 'default_terminal_mode' }, { enabled: open })
  )
  const setSettingMutation = useMutation(trpc.settings.set.mutationOptions())

  useEffect(() => {
    const m = defaultModeQuery.data
    if (open && m) setDefaultTerminalMode(m as TerminalMode)
  }, [open, defaultModeQuery.data])

  useEffect(() => {
    if (!open) return
    const onSettingsChanged = () => {
      void defaultModeQuery.refetch()
    }
    window.addEventListener('sz:settings-changed', onSettingsChanged)
    return () => window.removeEventListener('sz:settings-changed', onSettingsChanged)
  }, [open, defaultModeQuery.refetch])

  const onDefaultTerminalModeChange = useCallback(
    (mode: TerminalMode) => {
      setDefaultTerminalMode(mode)
      setSettingMutation.mutate({ key: 'default_terminal_mode', value: mode })
      window.dispatchEvent(new CustomEvent('sz:settings-changed'))
    },
    []
  )

  useEffect(() => {
    if (!open) return
    setActiveTab(initialTab)
    void defaultModeQuery.refetch()
  }, [open, initialTab, defaultModeQuery.refetch])

  const navigateTo = (tab: string) => {
    setActiveTab(tab)
    onTabChange?.(tab)
  }

  const navItems = [
    {
      key: 'appearance',
      label: 'Appearance',
      children: [{ key: 'appearance/layout', label: 'Layout' }]
    },
    { key: 'worktrees', label: 'Worktrees' },
    { key: 'ai-providers', label: 'Providers' },
    {
      key: 'panels',
      label: 'Panels',
      children: [
        { key: 'panels/terminal', label: 'Agent' },
        { key: 'panels/browser', label: 'Browser' },
        { key: 'panels/editor', label: 'Editor' },
        { key: 'panels/git', label: 'Git' }
      ]
    },
    { key: 'data', label: 'Import & Export' },
    { key: 'backup', label: 'Backup' },
    { key: 'labs', label: 'Labs' },
    { key: 'mcp', label: 'MCP' },
    { key: 'server', label: 'Server' },
    { key: 'diagnostics', label: 'Diagnostics' },
    { key: 'telemetry', label: 'Telemetry' },
    { key: 'about', label: 'About' }
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="project-settings"
        showCloseButton={false}
        aria-label="Settings"
        className="overflow-hidden p-0"
      >
        <div className="border-b px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg leading-none font-semibold">Settings</h2>
            <button
              type="button"
              className="hover:bg-accent rounded-xs p-1 opacity-70 transition-opacity hover:opacity-100"
              onClick={() => onOpenChange(false)}
            >
              <XIcon className="size-4" />
            </button>
          </div>
        </div>

        <SettingsLayout items={navItems} activeKey={activeTab} onSelect={navigateTo}>
          <div className="mx-auto w-full max-w-4xl space-y-8">
            {activeTab === 'worktrees' && <WorktreesSettingsTab />}

            {activeTab === 'appearance' && <AppearanceSettingsTab />}

            {activeTab === 'appearance/layout' && <LayoutSettingsTab />}

            {(activeTab === 'ai-providers' || activeTab.startsWith('ai-providers/')) && (
              <AiProvidersSettingsTab
                activeTab={activeTab}
                navigateTo={navigateTo}
                modes={modes}
                createMode={createMode}
                updateMode={updateMode}
                deleteMode={deleteMode}
                testMode={testMode}
                restoreDefaults={restoreDefaults}
                resetToDefaultState={resetToDefaultState}
                defaultTerminalMode={defaultTerminalMode}
                onDefaultTerminalModeChange={onDefaultTerminalModeChange}
              />
            )}

            {(activeTab === 'panels' || activeTab.startsWith('panels/')) && (
              <PanelsSettingsTab
                activeTab={activeTab}
                navigateTo={navigateTo}
                modes={modes}
                defaultTerminalMode={defaultTerminalMode}
                onDefaultTerminalModeChange={onDefaultTerminalModeChange}
              />
            )}

            {activeTab === 'data' && <DataSettingsTab />}

            {activeTab === 'backup' && <BackupSettingsTab />}

            {activeTab === 'labs' && <LabsSettingsTab />}

            {activeTab === 'mcp' && <McpSettingsTab />}

            {activeTab === 'server' && <ServerSettingsTab />}

            {activeTab === 'diagnostics' && <DiagnosticsSettingsTab />}

            {activeTab === 'telemetry' && <TelemetrySettingsTab />}

            {activeTab === 'about' && <AboutSettingsTab />}
          </div>
        </SettingsLayout>
      </DialogContent>
    </Dialog>
  )
}
