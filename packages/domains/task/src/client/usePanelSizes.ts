import { useState, useEffect, useCallback, useRef } from 'react'
import type { PanelVisibility } from '../shared/types'

export type PanelSize = number | 'auto'

export type PanelSizes = Record<string, PanelSize>

const DEFAULT_SIZES: PanelSizes = {
  terminal: 'auto',
  browser: 'auto',
  diff: 'auto',
  settings: 440,
  feature: 380,
  editor: 'auto',
  processes: 600
}

const SETTINGS_KEY = 'taskDetailPanelSizes'
const HANDLE_WIDTH = 16 // w-4 = 1rem
// Bump when the storage schema changes to force migration
const STORAGE_VERSION = 4

// Built-in order: terminal, browser, editor, [web panels inserted here], diff, settings, feature, processes
const BUILTIN_ORDER = ['terminal', 'browser', 'editor', 'diff', 'settings', 'feature', 'processes']

/** Build ordered panel list: built-ins in fixed order, web panels between editor and diff */
export function buildPanelOrder(visibility: PanelVisibility): string[] {
  const order: string[] = []
  const webPanelIds = Object.keys(visibility).filter(id => id.startsWith('web:'))

  for (const id of BUILTIN_ORDER) {
    order.push(id)
    // Insert web panels after editor
    if (id === 'editor') {
      order.push(...webPanelIds)
    }
  }
  return order
}

export function resolveWidths(
  sizes: PanelSizes,
  visibility: PanelVisibility,
  containerWidth: number
): Record<string, number> {
  const panelOrder = buildPanelOrder(visibility)
  const visible = panelOrder.filter((p) => visibility[p])
  const handleCount = Math.max(0, visible.length - 1)
  const available = containerWidth - handleCount * HANDLE_WIDTH

  let fixedSum = 0
  let autoCount = 0
  for (const p of visible) {
    const s = sizes[p] ?? 'auto'
    if (s === 'auto') autoCount++
    else fixedSum += s
  }

  const autoWidth = autoCount > 0 ? Math.max(100, (available - fixedSum) / autoCount) : 0

  const result: Record<string, number> = {}
  for (const p of visible) {
    const s = sizes[p] ?? 'auto'
    result[p] = s === 'auto' ? autoWidth : (s as number)
  }
  return result
}

function persist(sizes: PanelSizes): void {
  window.api.settings.set(SETTINGS_KEY, JSON.stringify({ ...sizes, _v: STORAGE_VERSION }))
}

export function usePanelSizes(): [
  PanelSizes,
  (updates: Partial<PanelSizes>) => void,
  (panel: string) => void,
  () => void
] {
  const [sizes, setSizes] = useState<PanelSizes>(DEFAULT_SIZES)
  const loaded = useRef(false)

  useEffect(() => {
    window.api.settings.get(SETTINGS_KEY).then((stored) => {
      if (stored) {
        try {
          const parsed = JSON.parse(stored)
          if (parsed._v === STORAGE_VERSION) {
            const { _v, ...rest } = parsed
            setSizes({ ...DEFAULT_SIZES, ...rest })
          } else {
            // Old format — only keep settings width, reset everything else
            const migrated = { ...DEFAULT_SIZES, settings: parsed.settings ?? DEFAULT_SIZES.settings }
            setSizes(migrated)
            persist(migrated)
          }
        } catch {
          /* ignore parse errors */
        }
      }
      loaded.current = true
    })
  }, [])

  const updateSizes = useCallback((updates: Partial<PanelSizes>) => {
    setSizes((prev) => {
      const next: PanelSizes = { ...prev, ...updates } as PanelSizes
      if (loaded.current) persist(next)
      return next
    })
  }, [])

  const resetPanel = useCallback((panel: string) => {
    updateSizes({ [panel]: DEFAULT_SIZES[panel] ?? 'auto' })
  }, [updateSizes])

  const resetAll = useCallback(() => {
    updateSizes(DEFAULT_SIZES)
  }, [updateSizes])

  return [sizes, updateSizes, resetPanel, resetAll]
}
