import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  parseTerminalOptionAsMeta,
  type TerminalOptionAsMeta
} from '@slayzone/ui'
import { HubWideSection } from '../../settings-hub'
import { AgentHubSettings } from './AgentHubSettings'
import { CARD_CLASS } from './panels-settings.constants'
import { PanelLayoutControls } from './PanelLayoutControls'
import type { PanelSettingsState } from './usePanelSettings'

// Option is only a modifier question on macOS (elsewhere Alt is always Meta).
const IS_MAC = navigator.platform.startsWith('Mac')

const OPTION_AS_META_OPTIONS: Array<{
  value: TerminalOptionAsMeta
  label: string
  description: string
}> = [
  {
    value: 'auto',
    label: 'Auto',
    description:
      'Meta on US layouts. Where your layout types a character with Option (Option+2 = @ on Swedish), Option types it.'
  },
  {
    value: 'both',
    label: 'Both',
    description: 'Both Option keys send Meta. Characters that need Option cannot be typed.'
  },
  {
    value: 'left',
    label: 'Left',
    description: 'Left Option sends Meta; right Option types characters.'
  },
  {
    value: 'right',
    label: 'Right',
    description: 'Right Option sends Meta; left Option types characters.'
  },
  {
    value: 'none',
    label: 'Off',
    description: 'Option always types characters, like macOS Terminal. Option+←/→ still jump words.'
  }
]

export function TerminalPanelSettings({ state }: { state: PanelSettingsState }) {
  const {
    panelConfig,
    savePanelConfig,
    setSetting,
    terminalFontFamily,
    setTerminalFontFamily,
    terminalScrollback,
    setTerminalScrollback,
    terminalForceCompatibilityRenderer,
    setTerminalForceCompatibilityRenderer,
    terminalOptionAsMeta,
    setTerminalOptionAsMeta
  } = state
  return (
    <>
      <div className={CARD_CLASS}>
        <Label className="text-base font-semibold">Agents</Label>
        <HubWideSection>
          <AgentHubSettings />
        </HubWideSection>
      </div>
      <div className={CARD_CLASS}>
        <Label className="text-base font-semibold">Terminal</Label>
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
        {IS_MAC && (
          <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
            <span className="text-sm text-muted-foreground">Option as Meta</span>
            <div className="flex items-center gap-2">
              <Select
                value={terminalOptionAsMeta}
                onValueChange={(v) => {
                  const next = parseTerminalOptionAsMeta(v)
                  setTerminalOptionAsMeta(next)
                  setSetting('terminal_option_as_meta', next)
                }}
              >
                <SelectTrigger className="w-32 shrink-0" data-testid="terminal-option-as-meta">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {OPTION_AS_META_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                {OPTION_AS_META_OPTIONS.find((o) => o.value === terminalOptionAsMeta)?.description}
              </span>
            </div>
          </div>
        )}
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
        <PanelLayoutControls
          orderId="terminal"
          panelConfig={panelConfig}
          onSave={savePanelConfig}
        />
      </div>
    </>
  )
}
