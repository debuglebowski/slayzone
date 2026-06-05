import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import type { PanelConfig, PanelLayout, PanelUnit, PanelAlign } from '@slayzone/task/shared'
import { coerceBound, panelLayoutFallback } from '@slayzone/task/shared'

/** Per-panel default layout editor (size + unit + min/max + anchor). Writes to
 *  panel_config.layout[orderId]; falls back to the hardcoded default when unset. */
export function PanelLayoutControls({
  orderId,
  panelConfig,
  onSave
}: {
  orderId: string
  panelConfig: PanelConfig
  onSave: (next: PanelConfig) => void
}) {
  const raw = panelConfig.layout?.[orderId] ?? panelLayoutFallback(orderId)
  const layout: PanelLayout = { ...raw, min: coerceBound(raw.min), max: coerceBound(raw.max) }
  const update = (patch: Partial<PanelLayout>): void => {
    const next: PanelLayout = { ...layout, ...patch }
    onSave({ ...panelConfig, layout: { ...(panelConfig.layout ?? {}), [orderId]: next } })
  }
  const numOrUndef = (s: string): number | undefined => {
    const n = Number(s)
    return s.trim() === '' || Number.isNaN(n) ? undefined : n
  }
  // A min/max bound row: number input + unit picker (px / fr / % of window).
  const renderBound = (key: 'min' | 'max', label: string) => {
    const dim = layout[key]
    return (
      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
        <span className="text-sm text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            className="w-24"
            placeholder="none"
            value={dim != null ? String(dim.value) : ''}
            onChange={(e) => {
              const v = numOrUndef(e.target.value)
              update({
                [key]: v == null ? undefined : { value: v, unit: dim?.unit ?? 'px' }
              } as Partial<PanelLayout>)
            }}
          />
          <Select
            value={dim?.unit ?? 'px'}
            onValueChange={(u) =>
              dim &&
              update({ [key]: { value: dim.value, unit: u as PanelUnit } } as Partial<PanelLayout>)
            }
          >
            <SelectTrigger className="w-auto min-w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="px">px</SelectItem>
              <SelectItem value="fr">fr</SelectItem>
              <SelectItem value="pct">% of window</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <Label className="text-base font-semibold">Layout</Label>
      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
        <span className="text-sm text-muted-foreground">Default size</span>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            className="w-24"
            value={String(layout.value)}
            onChange={(e) => update({ value: Number(e.target.value) || 0 })}
          />
          <Select value={layout.unit} onValueChange={(v) => update({ unit: v as PanelUnit })}>
            <SelectTrigger className="w-auto min-w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="px">px</SelectItem>
              <SelectItem value="fr">fr (fill)</SelectItem>
              <SelectItem value="pct">% of window</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {renderBound('min', 'Min width')}
      {renderBound('max', 'Max width')}
      <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
        <span className="text-sm text-muted-foreground">Align</span>
        <Select value={layout.align ?? 'left'} onValueChange={(v) => update({ align: v as PanelAlign })}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="left">Left</SelectItem>
            <SelectItem value="right">Right</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
