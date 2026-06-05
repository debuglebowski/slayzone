import { CARD_CLASS } from './panels-settings.constants'
import { PanelLayoutControls } from './PanelLayoutControls'
import type { PanelSettingsState } from './usePanelSettings'

/** Panels without dedicated settings (artifacts/settings/processes): just the
 *  Layout card — breadcrumb + enable toggle live in the tab title above. */
export function GenericPanelSettings({ state }: { state: PanelSettingsState }) {
  const { panelConfig, savePanelConfig, panelDetailId } = state
  if (!panelDetailId) return null
  return (
    <div className={CARD_CLASS}>
      <PanelLayoutControls
        orderId={panelDetailId}
        panelConfig={panelConfig}
        onSave={savePanelConfig}
      />
    </div>
  )
}
