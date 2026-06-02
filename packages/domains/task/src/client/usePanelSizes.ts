import { useState, useEffect, useCallback, useRef } from 'react'
import type { PanelVisibility, PanelSize, PanelSizes } from '../shared/types'

export type { PanelSize, PanelSizes }

/**
 * Default size per panel. Most panels are `flex` (weight 1) so they split the
 * leftover space equally and always reflow when panels open/close. `settings`
 * and `processes` are `fixed` — form-style panels that want a stable width.
 */
export const DEFAULT_SIZES: PanelSizes = {
  terminal: { kind: 'flex', weight: 1 },
  browser: { kind: 'flex', weight: 1 },
  diff: { kind: 'flex', weight: 1 },
  settings: { kind: 'fixed', px: 440 },
  editor: { kind: 'flex', weight: 1 },
  artifacts: { kind: 'flex', weight: 1 },
  processes: { kind: 'fixed', px: 600 }
}

/** Smallest width a panel may be dragged/resolved to. Web panels fall back to DEFAULT_MIN_WIDTH. */
const MIN_WIDTHS: Record<string, number> = {
  terminal: 200,
  browser: 200,
  editor: 250,
  artifacts: 200,
  diff: 50,
  settings: 200,
  processes: 200
}
const DEFAULT_MIN_WIDTH = 200

/** Minimum width for a panel id (built-in or `web:*`). */
export function minWidthFor(id: string): number {
  return MIN_WIDTHS[id] ?? DEFAULT_MIN_WIDTH
}

const HANDLE_WIDTH = 16 // w-4 = 1rem

// Built-in order: terminal, browser, editor, [web panels inserted here], diff, processes, settings
const BUILTIN_ORDER = [
  'terminal',
  'browser',
  'editor',
  'artifacts',
  'diff',
  'processes',
  'settings'
]

/** Build ordered panel list: built-ins in fixed order, web panels between editor and diff */
export function buildPanelOrder(visibility: PanelVisibility): string[] {
  const order: string[] = []
  const webPanelIds = Object.keys(visibility).filter((id) => id.startsWith('web:'))

  for (const id of BUILTIN_ORDER) {
    order.push(id)
    // Insert web panels after editor
    if (id === 'editor') {
      order.push(...webPanelIds)
    }
  }
  return order
}

/** Size for a panel, defaulting unknown/unset panels to flex weight 1. Fixed
 *  defaults (settings/processes) are seeded into stored sizes at load time, so
 *  the resolver itself stays context-agnostic and is shared by task + home. */
function sizeFor(sizes: PanelSizes, key: string): PanelSize {
  return sizes[key] ?? { kind: 'flex', weight: 1 }
}

/** One visible panel for the sizing engine: storage/result `key` + its min px. */
export interface PanelEntry {
  key: string
  min: number
}

/**
 * Shared sizing engine for any ordered set of visible panels (task split-view
 * and home tab both use it — one model, one resolver). Fixed panels keep their
 * px; flex panels share whatever space is left after the fixed panels and the
 * resize handles, in proportion to their weights. Because the flex pool is
 * always re-divided, opening or closing a panel can never strand or overflow
 * one — fixing the "new panel doesn't fit" bug from pixel-pinned widths.
 * Returns px keyed by `entry.key`.
 */
export function resolveFlexWidths(
  entries: PanelEntry[],
  sizes: PanelSizes,
  containerWidth: number
): Record<string, number> {
  const handleCount = Math.max(0, entries.length - 1)
  const available = containerWidth - handleCount * HANDLE_WIDTH

  let fixedSum = 0
  let totalWeight = 0
  for (const e of entries) {
    const s = sizeFor(sizes, e.key)
    if (s.kind === 'fixed') fixedSum += s.px
    else totalWeight += s.weight
  }
  const flexAvail = Math.max(0, available - fixedSum)

  const result: Record<string, number> = {}
  for (const e of entries) {
    const s = sizeFor(sizes, e.key)
    if (s.kind === 'fixed') {
      result[e.key] = s.px
    } else {
      const raw = totalWeight > 0 ? (flexAvail * s.weight) / totalWeight : 0
      result[e.key] = Math.max(e.min, raw)
    }
  }
  return result
}

/** Task split-view widths: derives the visible/ordered entries from panel visibility. */
export function resolveWidths(
  sizes: PanelSizes,
  visibility: PanelVisibility,
  containerWidth: number
): Record<string, number> {
  const entries = buildPanelOrder(visibility)
    .filter((p) => visibility[p])
    .map((id) => ({ key: id, min: minWidthFor(id) }))
  return resolveFlexWidths(entries, sizes, containerWidth)
}

/**
 * Translate a boundary drag — the new resolved px of the two adjacent panels,
 * whose sum is preserved by ResizeHandle — back into stored sizes:
 * - both flex: redistribute their combined weight by the new px ratio. Their
 *   weight-sum is unchanged, so every other flex panel keeps its exact width.
 * - both fixed: store the new px on each (sum preserved → no shift).
 * - mixed: store the new px on the fixed panel only; the flex pool absorbs the
 *   delta collectively (gap-free; other flex panels may nudge slightly).
 */
export function applyBoundaryResize(
  sizes: PanelSizes,
  leftId: string,
  rightId: string,
  newLeftPx: number,
  newRightPx: number
): Partial<PanelSizes> {
  const l = sizeFor(sizes, leftId)
  const r = sizeFor(sizes, rightId)
  const updates: Partial<PanelSizes> = {}

  if (l.kind === 'flex' && r.kind === 'flex') {
    const oldSum = l.weight + r.weight
    const total = newLeftPx + newRightPx
    const wL = total > 0 ? (oldSum * newLeftPx) / total : l.weight
    updates[leftId] = { kind: 'flex', weight: wL }
    updates[rightId] = { kind: 'flex', weight: oldSum - wL }
  } else if (l.kind === 'fixed' && r.kind === 'fixed') {
    updates[leftId] = { kind: 'fixed', px: newLeftPx }
    updates[rightId] = { kind: 'fixed', px: newRightPx }
  } else if (l.kind === 'fixed') {
    updates[leftId] = { kind: 'fixed', px: newLeftPx }
  } else {
    updates[rightId] = { kind: 'fixed', px: newRightPx }
  }
  return updates
}

/**
 * Per-task panel sizes. Live state is updated on every drag frame; `commit`
 * persists the current sizes (call on drag end). `resetPanel`/`resetAll`
 * persist immediately. `persist` is a no-op-friendly callback the caller wires
 * to a per-task DB write (skipped for secondary windows).
 */
export function usePanelSizes(
  initial: PanelSizes | null | undefined,
  persist: (sizes: PanelSizes) => void
): [
  PanelSizes,
  (updates: Partial<PanelSizes>) => void,
  () => void,
  (panel: string) => void,
  () => void
] {
  const [sizes, setSizes] = useState<PanelSizes>(() => ({ ...DEFAULT_SIZES, ...(initial ?? {}) }))
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes

  // Live update only — no persistence (drag frames are high-frequency).
  const updateSizes = useCallback((updates: Partial<PanelSizes>) => {
    setSizes((prev) => ({ ...prev, ...updates }) as PanelSizes)
  }, [])

  // Persist the latest live sizes — call on drag end.
  const commit = useCallback(() => {
    persist(sizesRef.current)
  }, [persist])

  const resetPanel = useCallback(
    (panel: string) => {
      setSizes((prev) => {
        const next: PanelSizes = {
          ...prev,
          [panel]: DEFAULT_SIZES[panel] ?? { kind: 'flex', weight: 1 }
        }
        persist(next)
        return next
      })
    },
    [persist]
  )

  const resetAll = useCallback(() => {
    setSizes(DEFAULT_SIZES)
    persist(DEFAULT_SIZES)
  }, [persist])

  return [sizes, updateSizes, commit, resetPanel, resetAll]
}

// ── Global (non-task) panel sizes ────────────────────────────────────────────
// The home tab is a single, taskless surface, so its panel layout is shared
// globally (stored in app settings) rather than per task. It uses the SAME
// weight model + resolver (resolveFlexWidths) as tasks — only the storage is
// global here. Persists on every update.

/** Versioned key — the v1 store held the legacy `number | 'auto'` pixel model;
 *  this holds the weight model, so home resets to defaults once on upgrade. */
const GLOBAL_SETTINGS_KEY = 'homePanelSizesV2'

export function useGlobalPanelSizes(): [
  PanelSizes,
  (updates: Partial<PanelSizes>) => void,
  (panel: string) => void
] {
  const [sizes, setSizes] = useState<PanelSizes>({})
  const loaded = useRef(false)

  useEffect(() => {
    window.api.settings.get(GLOBAL_SETTINGS_KEY).then((stored) => {
      if (stored) {
        try {
          const parsed = JSON.parse(stored)
          if (parsed && typeof parsed === 'object') setSizes(parsed as PanelSizes)
        } catch {
          /* ignore parse errors */
        }
      }
      loaded.current = true
    })
  }, [])

  const persist = (next: PanelSizes): void => {
    window.api.settings.set(GLOBAL_SETTINGS_KEY, JSON.stringify(next))
  }

  const updateSizes = useCallback((updates: Partial<PanelSizes>) => {
    setSizes((prev) => {
      const next = { ...prev, ...updates } as PanelSizes
      if (loaded.current) persist(next)
      return next
    })
  }, [])

  // Reset a panel back to an equal flex share.
  const resetPanel = useCallback((panel: string) => {
    setSizes((prev) => {
      const next: PanelSizes = { ...prev, [panel]: { kind: 'flex', weight: 1 } }
      if (loaded.current) persist(next)
      return next
    })
  }, [])

  return [sizes, updateSizes, resetPanel]
}
