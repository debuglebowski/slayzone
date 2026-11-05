import { useState } from 'react'
import { XIcon } from 'lucide-react'
import { Dialog, DialogContent, SettingsLayout, useDepsChanged } from '@slayzone/ui'
import { useTelemetry, TelemetrySettings } from '@slayzone/telemetry/client'

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
import { ConnectionsSettingsTab } from './tabs/ConnectionsSettingsTab'
import { SettingsTabIntro } from './tabs/SettingsTabIntro'
import { SettingsHubProvider, SettingsHubPicker } from './settings-hub'

function TelemetrySettingsTab() {
  const { tier, setTier, lockedByHub, homeHubLabel, withheldHubs } = useTelemetry()
  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Telemetry"
        description="Choose what product usage data is collected. Telemetry helps improve reliability while honoring your selected privacy tier."
      />
      <TelemetrySettings
        tier={tier}
        onTierChange={setTier}
        lockedByHub={lockedByHub}
        homeHubLabel={homeHubLabel}
        withheldHubs={withheldHubs}
      />
    </div>
  )
}

interface UserSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: string
  onTabChange?: (tab: string) => void
}

export function UserSettingsDialog({
  open,
  onOpenChange,
  initialTab = 'appearance',
  onTabChange
}: UserSettingsDialogProps) {
  const [activeTab, setActiveTab] = useState(initialTab)
  // Legacy Server/Hubs/Computer tab keys now resolve to the merged Connections tab;
  // normalize for the nav highlight so an old deep-link selects it correctly.
  const navActiveKey =
    activeTab === 'server' || activeTab === 'hubs' || activeTab === 'computer'
      ? 'connections'
      : activeTab
  // Opening (or a new initialTab while open) shows initialTab. Applied while rendering,
  // so a reopen never mounts the last-viewed tab first (running its effects/fetches).
  const tabSourceChanged = useDepsChanged([open, initialTab])
  if (tabSourceChanged && open && activeTab !== initialTab) setActiveTab(initialTab)

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
    { key: 'connections', label: 'Connections' },
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
        <SettingsHubProvider>
          <div className="border-b px-6 py-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg leading-none font-semibold">Settings</h2>
              <div className="ml-auto">
                <SettingsHubPicker />
              </div>
              <button
                type="button"
                className="hover:bg-accent rounded-xs p-1 opacity-70 transition-opacity hover:opacity-100"
                onClick={() => onOpenChange(false)}
              >
                <XIcon className="size-4" />
              </button>
            </div>
          </div>

          <SettingsLayout items={navItems} activeKey={navActiveKey} onSelect={navigateTo}>
            <div className="mx-auto w-full max-w-4xl space-y-8">
              {activeTab === 'worktrees' && <WorktreesSettingsTab />}

              {activeTab === 'appearance' && <AppearanceSettingsTab />}

              {activeTab === 'appearance/layout' && <LayoutSettingsTab />}

              {(activeTab === 'ai-providers' || activeTab.startsWith('ai-providers/')) && (
                <AiProvidersSettingsTab activeTab={activeTab} navigateTo={navigateTo} />
              )}

              {(activeTab === 'panels' || activeTab.startsWith('panels/')) && (
                <PanelsSettingsTab activeTab={activeTab} navigateTo={navigateTo} />
              )}

              {activeTab === 'data' && <DataSettingsTab />}

              {activeTab === 'backup' && <BackupSettingsTab />}

              {activeTab === 'labs' && <LabsSettingsTab />}

              {activeTab === 'mcp' && <McpSettingsTab />}

              {/* Server / Hubs / Computer consolidated into one Connections tab.
                Legacy deep-links to the old keys still resolve here. */}
              {(activeTab === 'connections' ||
                activeTab === 'server' ||
                activeTab === 'hubs' ||
                activeTab === 'computer') && <ConnectionsSettingsTab />}

              {activeTab === 'diagnostics' && <DiagnosticsSettingsTab />}

              {activeTab === 'telemetry' && <TelemetrySettingsTab />}

              {activeTab === 'about' && <AboutSettingsTab />}
            </div>
          </SettingsLayout>
        </SettingsHubProvider>
      </DialogContent>
    </Dialog>
  )
}
