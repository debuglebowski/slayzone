import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  PanelLayout,
  PanelSizeOverride,
  PanelSizes,
  PanelConfig
} from '../shared/types'
import { taskIdToOrderId, panelLayoutFallback, DEFAULT_PANEL_MIN_WIDTH } from '../shared/types'

export type { PanelLayout, PanelSizeOverride, PanelSizes }

const HANDLE_WIDTH = 16 // w-4 = 1rem

/** Fallback minimum width for a runtime panel id (used when no effective layout handy). */
export function minWidthFor(id: string): number {
  return panelLayoutFallback(taskIdToOrderId(id)).min ?? DEFAULT_PANEL_MIN_WIDTH
}

/**
 * Effective layout for a runtime panel id = hardcoded fallback ◀ global default
 * (panel_config.layout) ◀ per-task/home size override. min/max/align always come
 * from the default; the override only changes unit+value (the dragged size).
 */
export function effectiveLayout(
  runtimeId: string,
  config: PanelConfig | null | undefined,
  overrides: PanelSizes
): PanelLayout {
  const orderId = taskIdToOrderId(runtimeId)
  const base: PanelLayout = { ...panelLayoutFallback(orderId), ...(config?.layout?.[orderId] ?? {}) }
  const ov = overrides[runtimeId]
  return ov ? { ...base, unit: ov.unit, value: ov.value } : base
}

export interface ResolvedLayout {
  /** runtime-panel-id → resolved px width */
  widths: Record<string, number>
  /** width of the flexible gap between the left and right clusters (0 if no right cluster) */
  gapPx: number
  /** true when panels + handles exceed the container (→ horizontal scroll) */
  overflow: boolean
  /** left-anchored panel ids, in order */
  leftKeys: string[]
  /** right-anchored panel ids, in order */
  rightKeys: string[]
}

function clampMinMax(w: number, l: PanelLayout): number {
  let v = w
  if (l.min != null) v = Math.max(v, l.min)
  if (l.max != null) v = Math.min(v, Math.max(l.min ?? 0, l.max))
  return v
}

/**
 * Resolve a Figma/CSS-grid-like layout to concrete px widths.
 * - `px`/`pct` panels are static (pct = % of the whole container), clamped to min/max.
 * - `fr` panels share the leftover via bounded lock-and-redistribute: any panel
 *   whose share clamps to its min/max is pinned and the rest re-divide the remainder
 *   (a single pass silently over/underfills when an fr panel clamps).
 * - Right-anchored panels pack to the right; `gapPx` is the leftover between clusters.
 *   When statics overflow the container, `gapPx` is 0 and `overflow` is true.
 */
export function resolveLayout(
  panels: { key: string; layout: PanelLayout }[],
  containerWidth: number
): ResolvedLayout {
  const W = containerWidth
  const leftKeys = panels.filter((p) => (p.layout.align ?? 'left') !== 'right').map((p) => p.key)
  const rightKeys = panels.filter((p) => (p.layout.align ?? 'left') === 'right').map((p) => p.key)
  // A resize handle sits at EVERY panel boundary, including the left↔right anchor
  // boundary (when both clusters exist). The handle both provides the gap and
  // resizes its two neighbors, so panels never touch regardless of alignment.
  const hasBoundaryHandle = leftKeys.length > 0 && rightKeys.length > 0
  const handleCount =
    Math.max(0, leftKeys.length - 1) +
    Math.max(0, rightKeys.length - 1) +
    (hasBoundaryHandle ? 1 : 0)
  const handlesPx = handleCount * HANDLE_WIDTH

  const widths: Record<string, number> = {}
  let staticSum = 0
  const frEntries: { key: string; layout: PanelLayout }[] = []
  for (const p of panels) {
    const l = p.layout
    if (l.unit === 'fr') {
      frEntries.push(p)
      continue
    }
    const raw = l.unit === 'px' ? l.value : (l.value / 100) * W
    const w = clampMinMax(raw, l)
    widths[p.key] = w
    staticSum += w
  }

  // fr: bounded lock-and-redistribute
  let pool = Math.max(0, W - staticSum - handlesPx)
  let active = [...frEntries]
  const assigned: Record<string, number> = {}
  while (active.length > 0) {
    const totalWeight = active.reduce((s, p) => s + Math.max(0, p.layout.value), 0)
    if (totalWeight <= 0) {
      for (const p of active) assigned[p.key] = clampMinMax(0, p.layout)
      break
    }
    const locked: string[] = []
    let lockedSum = 0
    for (const p of active) {
      const share = (pool * Math.max(0, p.layout.value)) / totalWeight
      const clamped = clampMinMax(share, p.layout)
      if (Math.abs(clamped - share) > 0.01) {
        assigned[p.key] = clamped
        locked.push(p.key)
        lockedSum += clamped
      }
    }
    if (locked.length === 0) {
      for (const p of active) {
        assigned[p.key] = (pool * Math.max(0, p.layout.value)) / totalWeight
      }
      break
    }
    pool -= lockedSum
    active = active.filter((p) => !locked.includes(p.key))
  }
  let frSum = 0
  for (const p of frEntries) {
    widths[p.key] = assigned[p.key] ?? 0
    frSum += widths[p.key]
  }

  const usedExclGap = staticSum + frSum + handlesPx
  // Leftover beyond panels + handles → the anchor push between the clusters
  // (can be 0; the boundary handle already separates them).
  const gapPx = rightKeys.length > 0 ? Math.max(0, W - usedExclGap) : 0
  const overflow = usedExclGap > W + 0.5

  return { widths, gapPx, overflow, leftKeys, rightKeys }
}

/**
 * Placement plan for rendering a resolved layout — the single source of truth for
 * where panels, resize handles, and the anchor-gap spacer go. Both the task
 * split-view (renders panels as fixed JSX blocks, ordered via flex `order`) and
 * the home tab (renders via map in `renderOrder`) consume this, so the cluster /
 * neighbor / spacer logic lives (and is tested) in exactly one place.
 */
export interface PanelStripPlan {
  /** Visible panel keys in visual order (left cluster then right cluster). */
  renderOrder: string[]
  /** Index in renderOrder where the right (anchored) cluster begins. */
  rightStart: number
  /** Flex `order` value per panel key. */
  order: Record<string, number>
  /** Flex `order` for the gap spacer, or null when there's no right cluster. */
  spacerOrder: number | null
  /** Resize-handle left neighbor per key; the first right panel maps to the last
   *  left panel (the boundary handle spans the anchor gap). Absent = no handle. */
  leftNeighbor: Record<string, string>
  /** Flexible anchor-push width between the clusters (may be 0). */
  gapPx: number
}

export function planPanelStrip(resolved: ResolvedLayout): PanelStripPlan {
  const { leftKeys, rightKeys, gapPx } = resolved
  const order: Record<string, number> = {}
  const leftNeighbor: Record<string, string> = {}
  leftKeys.forEach((id, i) => {
    order[id] = i
    if (i > 0) leftNeighbor[id] = leftKeys[i - 1]
  })
  const spacerOrder = rightKeys.length > 0 ? leftKeys.length : null
  const rightBase = leftKeys.length + 1 // +1 reserves the spacer slot
  rightKeys.forEach((id, i) => {
    order[id] = rightBase + i
    if (i > 0) leftNeighbor[id] = rightKeys[i - 1]
    else if (leftKeys.length > 0) leftNeighbor[id] = leftKeys[leftKeys.length - 1]
  })
  return {
    renderOrder: [...leftKeys, ...rightKeys],
    rightStart: leftKeys.length,
    order,
    spacerOrder,
    leftNeighbor,
    gapPx
  }
}

/** Convenience: build entries from ordered ids + effective layouts, then resolve. */
export function resolvePanels(
  orderedIds: string[],
  config: PanelConfig | null | undefined,
  overrides: PanelSizes,
  containerWidth: number
): ResolvedLayout {
  const panels = orderedIds.map((id) => ({ key: id, layout: effectiveLayout(id, config, overrides) }))
  return resolveLayout(panels, containerWidth)
}

/**
 * Translate a boundary drag (new resolved px for the two adjacent panels, sum
 * preserved by ResizeHandle) into size-only overrides, keeping each panel's unit:
 * - both fr: redistribute combined weight by the new px ratio (others unchanged).
 * - both static: write each in its own unit (px→px, pct→% of container).
 * - mixed: write the STATIC side only; the fr side reflows (writing both drifts
 *   as the fr pool shifts).
 */
export function applyBoundaryResize(
  leftLayout: PanelLayout,
  rightLayout: PanelLayout,
  leftId: string,
  rightId: string,
  newLeftPx: number,
  newRightPx: number,
  containerWidth: number
): Partial<PanelSizes> {
  const toStatic = (l: PanelLayout, px: number): PanelSizeOverride =>
    l.unit === 'pct'
      ? { unit: 'pct', value: containerWidth > 0 ? (px / containerWidth) * 100 : l.value }
      : { unit: 'px', value: px }

  const lFr = leftLayout.unit === 'fr'
  const rFr = rightLayout.unit === 'fr'
  const updates: Partial<PanelSizes> = {}

  if (lFr && rFr) {
    const oldSum = leftLayout.value + rightLayout.value
    const total = newLeftPx + newRightPx
    const wL = total > 0 ? (oldSum * newLeftPx) / total : leftLayout.value
    updates[leftId] = { unit: 'fr', value: wL }
    updates[rightId] = { unit: 'fr', value: oldSum - wL }
  } else if (!lFr && !rFr) {
    updates[leftId] = toStatic(leftLayout, newLeftPx)
    updates[rightId] = toStatic(rightLayout, newRightPx)
  } else if (lFr) {
    updates[rightId] = toStatic(rightLayout, newRightPx)
  } else {
    updates[leftId] = toStatic(leftLayout, newLeftPx)
  }
  return updates
}

/** Normalize stored overrides, converting any legacy `{kind:'fixed'|'flex'}` shape. */
export function normalizeOverrides(raw: unknown): PanelSizes {
  if (!raw || typeof raw !== 'object') return {}
  const out: PanelSizes = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    if (o.unit === 'px' || o.unit === 'fr' || o.unit === 'pct') {
      out[k] = { unit: o.unit, value: Number(o.value) || 0 }
    } else if (o.kind === 'fixed') {
      out[k] = { unit: 'px', value: Number(o.px) || 0 }
    } else if (o.kind === 'flex') {
      out[k] = { unit: 'fr', value: Number(o.weight) || 1 }
    }
  }
  return out
}

/**
 * Per-task panel size overrides. Live state updates on every drag frame; `commit`
 * persists (call on drag end). `resetPanel`/`resetAll` delete overrides so the
 * panel falls back to its global default. `persist` is wired to a per-task DB
 * write (skipped for secondary windows).
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
  const [sizes, setSizes] = useState<PanelSizes>(() => ({ ...(initial ?? {}) }))
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes

  const updateSizes = useCallback((updates: Partial<PanelSizes>) => {
    setSizes((prev) => ({ ...prev, ...updates }) as PanelSizes)
  }, [])

  const commit = useCallback(() => {
    persist(sizesRef.current)
  }, [persist])

  const resetPanel = useCallback(
    (panel: string) => {
      setSizes((prev) => {
        const { [panel]: _drop, ...rest } = prev
        persist(rest)
        return rest
      })
    },
    [persist]
  )

  const resetAll = useCallback(() => {
    setSizes({})
    persist({})
  }, [persist])

  return [sizes, updateSizes, commit, resetPanel, resetAll]
}

// ── Global (non-task) panel size overrides ───────────────────────────────────
// The home tab is taskless, so its size overrides are shared globally (settings).
// Same model/resolver as tasks — only storage differs. Persists on every update.

/** Versioned key — v2 held the legacy `{kind}` model; v3 holds `{unit,value}`. */
const GLOBAL_SETTINGS_KEY = 'homePanelSizesV3'

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
          setSizes(normalizeOverrides(JSON.parse(stored)))
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

  const resetPanel = useCallback((panel: string) => {
    setSizes((prev) => {
      const { [panel]: _drop, ...rest } = prev
      if (loaded.current) persist(rest)
      return rest
    })
  }, [])

  return [sizes, updateSizes, resetPanel]
}
