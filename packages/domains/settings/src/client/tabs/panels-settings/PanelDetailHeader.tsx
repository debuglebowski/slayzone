import { Switch } from '@slayzone/ui'
import { PanelBreadcrumb } from '../PanelBreadcrumb'
import { buildPanelRowDescriptors } from './panels-settings.utils'
import type { PanelSettingsState } from './usePanelSettings'

/** Breadcrumb + home/task toggles shown atop every panel detail view. */
export function PanelDetailHeader({ state }: { state: PanelSettingsState }) {
  const { panelConfig, navigateTo, togglePanel, panelDetailId } = state
  if (!panelDetailId) return null
  const d = buildPanelRowDescriptors(panelConfig, navigateTo, togglePanel).get(panelDetailId)
  return (
    <div className="flex items-center justify-between">
      <PanelBreadcrumb label={d?.label ?? panelDetailId} onBack={() => navigateTo('panels')} />
      <div className="flex items-center gap-5 shrink-0">
        {d?.homeToggle && (
          <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            Home
            <Switch
              checked={d.homeToggle.enabled}
              onCheckedChange={d.homeToggle.onChange}
            />
          </label>
        )}
        {d?.taskToggle && (
          <label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            Task
            <Switch
              checked={d.taskToggle.enabled}
              onCheckedChange={d.taskToggle.onChange}
            />
          </label>
        )}
      </div>
    </div>
  )
}
