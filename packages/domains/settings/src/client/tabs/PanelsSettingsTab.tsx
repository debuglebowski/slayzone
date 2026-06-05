import { SettingsTabIntro } from './SettingsTabIntro'
import {
  usePanelSettings,
  PanelDetailHeader,
  PanelList,
  TerminalPanelSettings,
  BrowserPanelSettings,
  EditorPanelSettings,
  GitPanelSettings,
  WebPanelSettings,
  GenericPanelSettings
} from './panels-settings'
import type { PanelsSettingsTabProps } from './panels-settings'

export function PanelsSettingsTab({
  activeTab,
  navigateTo,
  modes,
  defaultTerminalMode,
  onDefaultTerminalModeChange
}: PanelsSettingsTabProps) {
  const s = usePanelSettings(activeTab, navigateTo)
  const { panelDetailId } = s

  return (
    <div className="space-y-6">
      {activeTab === 'panels' ? (
        <SettingsTabIntro
          title="Panels"
          description="Choose which panels are available per view."
        />
      ) : panelDetailId ? (
        <PanelDetailHeader state={s} />
      ) : null}

      {activeTab === 'panels' && <PanelList state={s} />}

      {activeTab === 'panels/terminal' && (
        <TerminalPanelSettings
          state={s}
          modes={modes}
          defaultTerminalMode={defaultTerminalMode}
          onDefaultTerminalModeChange={onDefaultTerminalModeChange}
        />
      )}

      {activeTab === 'panels/browser' && <BrowserPanelSettings state={s} />}

      {activeTab === 'panels/editor' && <EditorPanelSettings state={s} />}

      {activeTab === 'panels/git' && <GitPanelSettings state={s} />}

      {panelDetailId && panelDetailId.startsWith('web:') && <WebPanelSettings state={s} />}

      {panelDetailId &&
        ['artifacts', 'settings', 'processes'].includes(panelDetailId) && (
          <GenericPanelSettings state={s} />
        )}
    </div>
  )
}
