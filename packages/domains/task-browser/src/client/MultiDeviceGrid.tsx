import React, { useRef, useState, useEffect, useMemo } from 'react'
import { ChevronDown } from 'lucide-react'
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel
} from '@slayzone/ui'
import type { DeviceSlot, DeviceEmulation, GridLayout, MultiDeviceConfig } from '../shared'
import { presetsForSlot } from './device-presets'
import { DeviceWebview, type DeviceLayout } from './DeviceWebview'

const SLOTS: DeviceSlot[] = ['desktop', 'tablet', 'mobile']

/** Group presets by category ('Other' when unset), preserving first-seen order. */
function groupPresetsByCategory<P extends { category?: string }>(presets: P[]): [string, P[]][] {
  return Object.entries(
    presets.reduce<Record<string, P[]>>((acc, p) => {
      const cat = p.category ?? 'Other'
      ;(acc[cat] ??= []).push(p)
      return acc
    }, {})
  )
}

interface MultiDeviceGridProps {
  config: MultiDeviceConfig
  layout: GridLayout
  url: string
  isResizing?: boolean
  reloadTrigger?: number
  forceReloadTrigger?: number
  onPresetChange?: (slot: DeviceSlot, preset: DeviceEmulation) => void
}

interface DeviceColumnProps {
  slot: DeviceSlot
  preset: DeviceEmulation
  url: string
  isResizing: boolean
  reloadTrigger?: number
  forceReloadTrigger?: number
  flex: number
  onPresetChange?: (preset: DeviceEmulation) => void
}

function DeviceColumn({
  slot,
  preset,
  url,
  isResizing,
  reloadTrigger,
  forceReloadTrigger,
  flex,
  onPresetChange
}: DeviceColumnProps) {
  const [layout, setLayout] = useState<DeviceLayout | null>(null)
  const [customW, setCustomW] = useState(String(preset.width))
  const [customH, setCustomH] = useState(String(preset.height))
  // Re-seed the custom inputs when the preset size changes. Adjusted during
  // render — same trigger as a `[preset.width, preset.height]` effect.
  const [customSource, setCustomSource] = useState({ w: preset.width, h: preset.height })
  if (!Object.is(customSource.w, preset.width) || !Object.is(customSource.h, preset.height)) {
    setCustomSource({ w: preset.width, h: preset.height })
    setCustomW(String(preset.width))
    setCustomH(String(preset.height))
  }
  const presets = presetsForSlot(slot)

  const applyCustom = () => {
    const w = parseInt(customW)
    const h = parseInt(customH)
    if (!w || !h || w < 1 || h < 1) return
    onPresetChange?.({ name: 'Custom', width: w, height: h, deviceScaleFactor: 1, mobile: false })
  }

  const labelTop = layout ? layout.topOffset + layout.scaledHeight + 12 : 0

  return (
    <div id={`column-${slot}`} className="relative flex flex-col min-w-0 min-h-0" style={{ flex }}>
      <DeviceWebview
        url={url}
        preset={preset}
        partition="persist:browser-tabs"
        isResizing={isResizing}
        reloadTrigger={reloadTrigger}
        forceReloadTrigger={forceReloadTrigger}
        onLayout={setLayout}
      />
      {layout && (
        <div
          className="absolute flex items-center justify-center pointer-events-none"
          style={{ top: labelTop, left: 0, width: layout.width }}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="pointer-events-auto flex items-center gap-1 text-xs font-medium text-foreground hover:text-muted-foreground transition-colors">
                <span>
                  {preset.name} — {preset.width}&times;{preset.height}
                </span>
                <ChevronDown className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-[336px]" align="center" side="bottom">
              <div className="max-h-72 overflow-y-auto">
                {groupPresetsByCategory(presets).map(([cat, items], gi) => (
                  <div key={cat}>
                    {gi > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuLabel className="text-[10px] text-muted-foreground px-2 py-1">
                      {cat}
                    </DropdownMenuLabel>
                    {items.map((p) => (
                      <DropdownMenuItem
                        key={p.name}
                        onClick={() => onPresetChange?.(p)}
                        className={cn(
                          'flex justify-between',
                          preset.name === p.name && 'text-blue-500 font-medium'
                        )}
                      >
                        <span>{p.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {p.width}&times;{p.height}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </div>
                ))}
              </div>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 flex items-center gap-1.5">
                <input
                  type="number"
                  value={customW}
                  onChange={(e) => setCustomW(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') applyCustom()
                  }}
                  placeholder="W"
                  className="w-16 h-6 px-1.5 text-xs bg-surface-2 border border-border rounded text-foreground focus:outline-none focus:border-ring"
                />
                <span className="text-xs text-muted-foreground">×</span>
                <input
                  type="number"
                  value={customH}
                  onChange={(e) => setCustomH(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') applyCustom()
                  }}
                  placeholder="H"
                  className="w-16 h-6 px-1.5 text-xs bg-surface-2 border border-border rounded text-foreground focus:outline-none focus:border-ring"
                />
                <button
                  onClick={applyCustom}
                  className="h-6 px-2 text-xs bg-accent hover:bg-accent rounded text-foreground transition-colors"
                >
                  Apply
                </button>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  )
}

export function MultiDeviceGrid({
  config,
  layout,
  url,
  isResizing,
  reloadTrigger,
  forceReloadTrigger,
  onPresetChange
}: MultiDeviceGridProps) {
  const enabledSlots = useMemo(() => SLOTS.filter((s) => config[s].enabled), [config])
  const containerRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const [flexOverrides, setFlexOverrides] = useState<Record<string, number>>({})
  const slotsKey = enabledSlots.join(',')
  // Drop drag-resized sizes when the set of enabled slots changes. Adjusted
  // during render — same trigger as a `[slotsKey]` effect.
  const [flexSlotsKey, setFlexSlotsKey] = useState(slotsKey)
  if (!Object.is(flexSlotsKey, slotsKey)) {
    setFlexSlotsKey(slotsKey)
    setFlexOverrides({})
  }

  const getFlexValue = (slot: DeviceSlot) => {
    if (layout === 'vertical') return 1
    if (flexOverrides[slot] != null) return flexOverrides[slot]
    return Math.max(config[slot].preset.width, 300)
  }

  const cleanupDragRef = useRef<(() => void) | null>(null)
  useEffect(
    () => () => {
      cleanupDragRef.current?.()
    },
    []
  )

  const handleDragStart = (e: React.MouseEvent, leftSlot: DeviceSlot, rightSlot: DeviceSlot) => {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return

    const isHorizontal = layout === 'horizontal'
    const containerSize = isHorizontal ? container.offsetWidth : container.offsetHeight

    const currentFlex: Record<string, number> = {}
    for (const s of enabledSlots) {
      currentFlex[s] = getFlexValue(s)
    }
    const totalFlex = Object.values(currentFlex).reduce((a, b) => a + b, 0)

    const startPos = isHorizontal ? e.clientX : e.clientY
    const leftStartFlex = currentFlex[leftSlot]
    const rightStartFlex = currentFlex[rightSlot]

    setDragging(true)

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = (isHorizontal ? ev.clientX : ev.clientY) - startPos
      const flexPerPx = totalFlex / containerSize
      const flexDelta = delta * flexPerPx

      const minFlex = totalFlex * 0.1
      const newLeft = Math.max(
        minFlex,
        Math.min(leftStartFlex + rightStartFlex - minFlex, leftStartFlex + flexDelta)
      )
      const newRight = leftStartFlex + rightStartFlex - newLeft

      setFlexOverrides((prev) => ({ ...prev, [leftSlot]: newLeft, [rightSlot]: newRight }))
    }

    const cleanup = () => {
      setDragging(false)
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      cleanupDragRef.current = null
    }
    const handleMouseUp = cleanup

    cleanupDragRef.current = cleanup
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }

  if (enabledSlots.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        Enable at least one device slot
      </div>
    )
  }

  const isHorizontal = layout === 'horizontal'

  return (
    <div
      id="grid-container"
      ref={containerRef}
      className={`flex-1 flex p-8 overflow-hidden bg-surface-0 ${isHorizontal ? 'flex-row' : 'flex-col'}`}
    >
      {enabledSlots.map((slot, i) => (
        <React.Fragment key={slot}>
          {i > 0 && (
            <div
              id={`resize-handle-${i}`}
              className={`shrink-0 relative group ${
                isHorizontal ? 'w-8 cursor-col-resize' : 'h-8 cursor-row-resize'
              }`}
              onMouseDown={(e) => handleDragStart(e, enabledSlots[i - 1], slot)}
            >
              <div
                id={`resize-pill-${i}`}
                className={`absolute rounded-full opacity-0 group-hover:opacity-100 group-active:opacity-100 bg-primary/30 group-active:bg-primary/50 transition-opacity ${
                  isHorizontal
                    ? 'w-1 h-8 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2'
                    : 'h-1 w-8 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
                }`}
              />
            </div>
          )}
          <DeviceColumn
            slot={slot}
            preset={config[slot].preset}
            url={url}
            isResizing={(isResizing ?? false) || dragging}
            reloadTrigger={reloadTrigger}
            forceReloadTrigger={forceReloadTrigger}
            flex={getFlexValue(slot)}
            onPresetChange={(p) => onPresetChange?.(slot, p)}
          />
        </React.Fragment>
      ))}
    </div>
  )
}
