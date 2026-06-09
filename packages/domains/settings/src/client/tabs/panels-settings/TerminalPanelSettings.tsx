import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Switch
} from '@slayzone/ui'
import type { TerminalMode, TerminalModeInfo } from '@slayzone/terminal/shared'
import { getVisibleModes, getModeLabel, groupTerminalModes } from '@slayzone/terminal'
import { CARD_CLASS } from './panels-settings.constants'
import { PanelLayoutControls } from './PanelLayoutControls'
import type { PanelSettingsState } from './usePanelSettings'

export function TerminalPanelSettings({
  state,
  modes,
  defaultTerminalMode,
  onDefaultTerminalModeChange
}: {
  state: PanelSettingsState
  modes: TerminalModeInfo[]
  defaultTerminalMode: TerminalMode
  onDefaultTerminalModeChange: (mode: TerminalMode) => void
}) {
  const {
    panelConfig,
    savePanelConfig,
    setSetting,
    terminalAutoStart,
    setTerminalAutoStart,
    terminalPrewarmEnabled,
    setTerminalPrewarmEnabled,
    terminalAutoCloseIdle,
    setTerminalAutoCloseIdle,
    terminalIdleCloseValue,
    setTerminalIdleCloseValue,
    terminalIdleCloseUnit,
    setTerminalIdleCloseUnit,
    terminalFontFamily,
    setTerminalFontFamily,
    terminalScrollback,
    setTerminalScrollback,
    terminalForceCompatibilityRenderer,
    setTerminalForceCompatibilityRenderer
  } = state
  return (
    <>
      <div className={CARD_CLASS}>
        <Label className="text-base font-semibold">General</Label>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Default agent provider</span>
          <Select
            value={defaultTerminalMode}
            onValueChange={(v) => onDefaultTerminalModeChange(v as TerminalMode)}
          >
            <SelectTrigger className="max-w-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              position="popper"
              align="start"
              className="min-w-[var(--radix-select-trigger-width)] max-h-none"
            >
              {(() => {
                const visibleModes = getVisibleModes(modes, defaultTerminalMode)
                const { builtin, custom } = groupTerminalModes(visibleModes)
                return (
                  <>
                    {builtin.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {getModeLabel(m)}
                      </SelectItem>
                    ))}
                    {custom.length > 0 && builtin.length > 0 && <SelectSeparator />}
                    {custom.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {getModeLabel(m)}
                      </SelectItem>
                    ))}
                  </>
                )
              })()}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Auto-start sessions</span>
          <div className="flex items-center gap-2">
            <Switch
              checked={terminalAutoStart}
              onCheckedChange={(c) => {
                setTerminalAutoStart(c)
                setSetting('terminal_auto_start', c ? '1' : '0')
              }}
            />
            <span className="text-xs text-muted-foreground">
              Spawn agent on tab open instead of showing the Start button.
            </span>
          </div>
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Pre-warm agent</span>
          <div className="flex items-center gap-2">
            <Switch
              checked={terminalPrewarmEnabled}
              onCheckedChange={(c) => {
                setTerminalPrewarmEnabled(c)
                setSetting('terminal_prewarm_enabled', c ? '1' : '0')
              }}
            />
            <span className="text-xs text-muted-foreground">
              Keep one ready agent shell per project with open tabs, so the first agent
              you open in it starts instantly (default provider, project root only).
            </span>
          </div>
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Auto-close idle agents</span>
          <div className="flex items-center gap-2">
            <Switch
              checked={terminalAutoCloseIdle}
              onCheckedChange={(c) => {
                setTerminalAutoCloseIdle(c)
                setSetting('terminal_auto_close_idle', c ? '1' : '0')
              }}
            />
            <span className="text-xs text-muted-foreground">
              Close the agent after it sits idle to free memory; reopen from the Start
              screen (the conversation resumes). Other terminals are never closed.
            </span>
          </div>
        </div>
        {terminalAutoCloseIdle && (
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Idle timeout</span>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                value={terminalIdleCloseValue}
                onChange={(e) => setTerminalIdleCloseValue(e.target.value)}
                onBlur={() => {
                  const n = Math.max(1, Math.floor(Number(terminalIdleCloseValue) || 30))
                  const v = String(n)
                  setTerminalIdleCloseValue(v)
                  setSetting('terminal_idle_close_value', v)
                }}
                className="w-24"
              />
              <Select
                value={terminalIdleCloseUnit}
                onValueChange={(u) => {
                  setTerminalIdleCloseUnit(u)
                  setSetting('terminal_idle_close_unit', u)
                }}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="seconds">Seconds</SelectItem>
                  <SelectItem value="minutes">Minutes</SelectItem>
                  <SelectItem value="hours">Hours</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Font family</span>
          <Input
            value={terminalFontFamily}
            onChange={(e) => setTerminalFontFamily(e.target.value)}
            onBlur={() => setSetting('terminal_font_family', terminalFontFamily.trim())}
          />
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Scrollback</span>
          <Input
            className="max-w-32"
            type="number"
            value={terminalScrollback}
            onChange={(e) => setTerminalScrollback(e.target.value)}
            onBlur={() => {
              const n = parseInt(terminalScrollback, 10)
              if (n >= 0) setSetting('terminal_scrollback', String(n))
            }}
          />
        </div>
        <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
          <span className="text-sm text-muted-foreground">Compatibility renderer</span>
          <div className="flex items-center gap-2">
            <Switch
              checked={terminalForceCompatibilityRenderer}
              onCheckedChange={(c) => {
                setTerminalForceCompatibilityRenderer(c)
                setSetting('terminal_force_compatibility_renderer', c ? '1' : '0')
              }}
            />
            <span className="text-xs text-muted-foreground">
              Force DOM renderer (disable WebGL) — use if you repeatedly hit glyph scrambling.
            </span>
          </div>
        </div>
      </div>
      <div className={CARD_CLASS}>
        <PanelLayoutControls orderId="terminal" panelConfig={panelConfig} onSave={savePanelConfig} />
      </div>
    </>
  )
}
