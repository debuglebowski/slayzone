import { useState, useEffect, useCallback, useRef } from 'react'
import { useSetting, useSetSettingMutation } from '@slayzone/settings/client'
import type { PanelVisibility } from '../shared/types'

export type PanelSize = number | 'auto'

export type PanelSizes = Record<string, PanelSize>

const DEFAULT_SIZES: PanelSizes = {
  terminal: 'auto',
  browser: 'auto',
  diff: 'auto',
  settings: 440,
  editor: 'auto',
  artifacts: 'auto',
  processes: 600
}

const SETTINGS_KEY = 'taskDetailPanelSizes'
const HANDLE_WIDTH = 16
// Bump when the storage schema changes to force migration
const STORAGE_VERSION = 5

const BUILTIN_ORDER = ['terminal', 'browser', 'editor', 'artifacts', 'diff', 'processes', 'settings']

/** Build ordered panel list: built-ins in fixed order, web panels between editor and diff */
export function buildPanelOrder(visibility: PanelVisibility): string[] {
  const order: string[] = []
  const webPanelIds = Object.keys(visibility).filter(id => id.startsWith('web:'))

  for (const id of BUILTIN_ORDER) {
    order.push(id)
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

export function usePanelSizes(): [
  PanelSizes,
  (updates: Partial<PanelSizes>) => void,
  (panel: string) => void,
  () => void
] {
  const stored = useSetting(SETTINGS_KEY)
  const setSetting = useSetSettingMutation()
  const [sizes, setSizes] = useState<PanelSizes>(DEFAULT_SIZES)
  const loaded = useRef(false)

  const persist = useCallback((next: PanelSizes) => {
    setSetting.mutate({ key: SETTINGS_KEY, value: JSON.stringify({ ...next, _v: STORAGE_VERSION }) })
  }, [setSetting])

  // Hydrate local state from cache on first load (and on remote changes).
  // Local mutations go through `persist` which writes optimistically to cache.
  useEffect(() => {
    if (stored === undefined) return  // not loaded yet
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        if (parsed._v === STORAGE_VERSION) {
          const { _v: _, ...rest } = parsed
          setSizes({ ...DEFAULT_SIZES, ...rest })
        } else {
          const migrated = { ...DEFAULT_SIZES, settings: parsed.settings ?? DEFAULT_SIZES.settings }
          setSizes(migrated)
          persist(migrated)
        }
      } catch {
        /* ignore parse errors */
      }
    }
    loaded.current = true
  }, [stored, persist])

  const updateSizes = useCallback((updates: Partial<PanelSizes>) => {
    setSizes((prev) => {
      const next: PanelSizes = { ...prev, ...updates } as PanelSizes
      if (loaded.current) persist(next)
      return next
    })
  }, [persist])

  const resetPanel = useCallback((panel: string) => {
    updateSizes({ [panel]: DEFAULT_SIZES[panel] ?? 'auto' })
  }, [updateSizes])

  const resetAll = useCallback(() => {
    updateSizes(DEFAULT_SIZES)
  }, [updateSizes])

  return [sizes, updateSizes, resetPanel, resetAll]
}
