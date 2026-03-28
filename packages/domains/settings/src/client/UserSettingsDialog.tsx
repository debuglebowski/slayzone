import { useState, useEffect } from 'react'
import { useTheme } from './ThemeContext'
import { XIcon } from 'lucide-react'
import { Dialog, DialogContent, SettingsLayout } from '@slayzone/ui'
import { useTerminalModes } from '@slayzone/terminal'
import { useTelemetry, TelemetrySettings } from '@slayzone/telemetry/client'
import {
  ContextManagerSettings,
  type GlobalContextManagerSection
} from '../../../ai-config/src/client/ContextManagerSettings'

// Import autonomous tabs
import { GeneralSettingsTab } from './tabs/GeneralSettingsTab'
import { AppearanceSettingsTab } from './tabs/AppearanceSettingsTab'
import { PanelsSettingsTab } from './tabs/PanelsSettingsTab'
import { AiProvidersSettingsTab } from './tabs/AiProvidersSettingsTab'
import { DataSettingsTab } from './tabs/DataSettingsTab'
import { DiagnosticsSettingsTab } from './tabs/DiagnosticsSettingsTab'
import { AboutSettingsTab } from './tabs/AboutSettingsTab'
import { WorktreesSettingsTab } from './tabs/WorktreesSettingsTab'
import { BackupSettingsTab } from './tabs/BackupSettingsTab'
import { LabsSettingsTab } from './tabs/LabsSettingsTab'
import { SettingsTabIntro } from './tabs/SettingsTabIntro'

function TelemetrySettingsTab() {
  const { tier, setTier } = useTelemetry()
  return (
    <div className="space-y-6">
      <SettingsTabIntro title="Telemetry" description="Choose what product usage data is collected. Telemetry helps improve reliability while honoring your selected privacy tier." />
      <TelemetrySettings tier={tier} onTierChange={setTier} />
    </div>
  )
}

interface UserSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: string
  initialAiConfigSection?: GlobalContextManagerSection | null
  onTabChange?: (tab: string) => void
}

export function UserSettingsDialog({
  open,
  onOpenChange,
  initialTab = 'general',
  initialAiConfigSection = null,
  onTabChange
}: UserSettingsDialogProps) {
  // Modes list is SHARED because multiple tabs (AI Providers, Panels) need it
  const { modes, createMode, updateMode, deleteMode, testMode, restoreDefaults, resetToDefaultState } = useTerminalModes()
  
  // Theme is SHARED because it affects the entire modal/app appearance
  const { preference, setPreference } = useTheme()
  
  const [activeTab, setActiveTab] = useState(initialTab)
  const [contextManagerEnabled, setContextManagerEnabled] = useState(false)

  useEffect(() => {
    if (open) {
      const resolvedInitialTab = !contextManagerEnabled && initialTab === 'ai-config' ? 'general' : initialTab
      setActiveTab(resolvedInitialTab)
    }
  }, [open, initialTab, contextManagerEnabled])

  useEffect(() => {
    window.api.app.isContextManagerEnabled().then(setContextManagerEnabled)
  }, [])

  const navigateTo = (tab: string) => {
    setActiveTab(tab)
    onTabChange?.(tab)
  }

  const navItems = [
    { key: 'general', label: 'General' },
    { key: 'appearance', label: 'Appearance' },
    { key: 'worktrees', label: 'Worktrees' },
    { key: 'ai-providers', label: 'Providers' },
    {
      key: 'panels',
      label: 'Panels',
      children: [
        { key: 'panels/terminal', label: 'Terminal' },
        { key: 'panels/browser', label: 'Browser' },
        { key: 'panels/editor', label: 'Editor' },
        { key: 'panels/git', label: 'Git' },
      ]
    },
    ...(contextManagerEnabled ? [{ key: 'ai-config', label: 'Context Manager' }] : []),
    { key: 'data', label: 'Import & Export' },
    { key: 'backup', label: 'Backup' },
    { key: 'labs', label: 'Labs' },
    { key: 'diagnostics', label: 'Diagnostics' },
    { key: 'telemetry', label: 'Telemetry' },
    { key: 'about', label: 'About' }
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="project-settings" showCloseButton={false} aria-label="Settings" className="overflow-hidden p-0">
        <div className="border-b px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg leading-none font-semibold">Settings</h2>
            <button type="button" className="hover:bg-accent rounded-xs p-1 opacity-70 transition-opacity hover:opacity-100" onClick={() => onOpenChange(false)}>
              <XIcon className="size-4" />
            </button>
          </div>
        </div>

        <SettingsLayout items={navItems} activeKey={activeTab} onSelect={navigateTo}>
          <div className="mx-auto w-full max-w-4xl space-y-8">
            {activeTab === 'general' && <GeneralSettingsTab />}

            {activeTab === 'worktrees' && <WorktreesSettingsTab />}

            {activeTab === 'appearance' && (
              <AppearanceSettingsTab
                preference={preference}
                setPreference={setPreference}
              />
            )}

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
              />
            )}

            {(activeTab === 'panels' || activeTab.startsWith('panels/')) && (
              <PanelsSettingsTab
                activeTab={activeTab}
                navigateTo={navigateTo}
                modes={modes}
              />
            )}

            {contextManagerEnabled && activeTab === 'ai-config' && (
              <div className="flex h-full min-h-0 flex-col gap-6">
                <div className="shrink-0">
                  <SettingsTabIntro title="Context Manager" description="Manage global instructions, skills, and provider behavior." />
                </div>
                <div className="min-h-0 flex-1">
                  <ContextManagerSettings scope="global" projectId={null} initialGlobalSection={initialAiConfigSection} />
                </div>
              </div>
            )}

            {activeTab === 'data' && <DataSettingsTab />}

            {activeTab === 'backup' && <BackupSettingsTab />}

            {activeTab === 'labs' && <LabsSettingsTab />}

            {activeTab === 'diagnostics' && <DiagnosticsSettingsTab />}

            {activeTab === 'telemetry' && <TelemetrySettingsTab />}

            {activeTab === 'about' && <AboutSettingsTab />}
          </div>
        </SettingsLayout>
      </DialogContent>
    </Dialog>
  )
}
