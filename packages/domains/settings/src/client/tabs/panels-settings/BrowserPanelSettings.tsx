import { Input, Label, Switch } from '@slayzone/ui'
import { CARD_CLASS } from './panels-settings.constants'
import { PanelLayoutControls } from './PanelLayoutControls'
import type { PanelSettingsState } from './usePanelSettings'

export function BrowserPanelSettings({ state }: { state: PanelSettingsState }) {
  const {
    panelConfig,
    savePanelConfig,
    devServerToastEnabled,
    setDevServerToastEnabled,
    devServerAutoOpenBrowser,
    setDevServerAutoOpenBrowser,
    browserDefaultUrl,
    setBrowserDefaultUrl,
    browserDefaultZoom,
    setBrowserDefaultZoom,
    browserDevices,
    setBrowserDevices,
    updateBrowserDevice
  } = state
  return (
    <>
      <div className={CARD_CLASS}>
        <Label className="text-base font-semibold">General</Label>
        <div className="space-y-3">
          <Label className="text-sm font-medium">Dev server</Label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={devServerToastEnabled}
              onChange={(e) => {
                setDevServerToastEnabled(e.target.checked)
                window.api.settings.set('dev_server_toast_enabled', e.target.checked ? '1' : '0')
              }}
            />
            <span>Show toast when detected</span>
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={devServerAutoOpenBrowser}
              onChange={(e) => {
                setDevServerAutoOpenBrowser(e.target.checked)
                window.api.settings.set(
                  'dev_server_auto_open_browser',
                  e.target.checked ? '1' : '0'
                )
              }}
            />
            <span>Auto-open when detected</span>
          </label>
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Default URL</span>
          <Input
            value={browserDefaultUrl}
            onChange={(e) => setBrowserDefaultUrl(e.target.value)}
            onBlur={() =>
              window.api.settings.set('browser_default_url', browserDefaultUrl.trim())
            }
          />
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Default zoom</span>
          <Input
            className="max-w-24"
            type="number"
            value={browserDefaultZoom}
            onChange={(e) => setBrowserDefaultZoom(e.target.value)}
            onBlur={() => {
              const n = parseInt(browserDefaultZoom, 10)
              if (n >= 50 && n <= 200) window.api.settings.set('browser_default_zoom', String(n))
            }}
          />
        </div>
        <div className="space-y-3">
          <Label className="text-sm font-medium">Device defaults</Label>
          {(['desktop', 'tablet', 'mobile'] as const).map((slot) => (
            <div key={slot} className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
              <span className="text-sm text-muted-foreground capitalize">{slot}</span>
              <div className="flex items-center gap-2">
                <Switch
                  checked={browserDevices[slot].enabled}
                  onCheckedChange={(c) => updateBrowserDevice(slot, 'enabled', c)}
                />
                <Input
                  className="max-w-20"
                  type="number"
                  value={browserDevices[slot].width}
                  onChange={(e) =>
                    setBrowserDevices((prev) => ({
                      ...prev,
                      [slot]: { ...prev[slot], width: e.target.value }
                    }))
                  }
                  onBlur={() => updateBrowserDevice(slot, 'width', browserDevices[slot].width)}
                />
                <span className="text-xs">×</span>
                <Input
                  className="max-w-20"
                  type="number"
                  value={browserDevices[slot].height}
                  onChange={(e) =>
                    setBrowserDevices((prev) => ({
                      ...prev,
                      [slot]: { ...prev[slot], height: e.target.value }
                    }))
                  }
                  onBlur={() => updateBrowserDevice(slot, 'height', browserDevices[slot].height)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className={CARD_CLASS}>
        <PanelLayoutControls orderId="browser" panelConfig={panelConfig} onSave={savePanelConfig} />
      </div>
    </>
  )
}
