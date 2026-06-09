// Layout store — zustand, mirroring the house style of useTerminalStateStore
// (create()(subscribeWithSelector(...)), immutable updates, selector hooks as
// the public API). All tree mutations delegate to the pure tree-ops; a single
// debounced subscription persists the tree to localStorage.
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { LayoutTree, Overlay, Tile } from './types'
import {
  insertTile,
  moveTileBetweenPanes,
  removeTile,
  replaceFractions,
  setActiveTile
} from './tree-ops'
import { saveTree } from './persistence'
import type { OcclusionPolicy } from './occlusion'
import { DEFAULT_OCCLUSION_POLICY, nativeTileVisible } from './occlusion'

export interface LayoutStore {
  tree: LayoutTree
  overlays: Overlay[]
  focusedNodeId: string | null
  taskId: string | null
  /** Split currently being divider-dragged (null = idle). */
  draggingSplitId: string | null
  occlusionPolicy: OcclusionPolicy

  /** Adopt a task id + its (already-resolved) initial tree. */
  bindTask(taskId: string, tree: LayoutTree): void
  setTree(tree: LayoutTree): void
  openTile(targetPaneId: string | null, tile: Tile): void
  closeTile(tileId: string): void
  moveTile(tileId: string, toPaneId: string, toIndex?: number): void
  setActiveTab(paneId: string, tileId: string): void
  /** Set a split's fractions (called live during a divider drag). */
  resizeSplit(splitId: string, fractions: number[]): void
  setDraggingSplit(splitId: string | null): void
  setOcclusionPolicy(policy: Partial<OcclusionPolicy>): void
  focusNode(nodeId: string): void
  openOverlay(overlay: Overlay): void
  closeOverlay(id: string): void
}

export const useLayoutStore = create<LayoutStore>()(
  subscribeWithSelector((set, get) => ({
    tree: { root: null },
    overlays: [],
    focusedNodeId: null,
    taskId: null,
    draggingSplitId: null,
    occlusionPolicy: DEFAULT_OCCLUSION_POLICY,

    bindTask: (taskId, tree) => set({ taskId, tree }),
    setTree: (tree) => set({ tree }),
    openTile: (targetPaneId, tile) => set({ tree: insertTile(get().tree, targetPaneId, tile) }),
    closeTile: (tileId) => set({ tree: removeTile(get().tree, tileId) }),
    moveTile: (tileId, toPaneId, toIndex) =>
      set({ tree: moveTileBetweenPanes(get().tree, tileId, toPaneId, toIndex) }),
    setActiveTab: (paneId, tileId) => set({ tree: setActiveTile(get().tree, paneId, tileId) }),
    resizeSplit: (splitId, fractions) => set({ tree: replaceFractions(get().tree, splitId, fractions) }),
    setDraggingSplit: (splitId) => set({ draggingSplitId: splitId }),
    setOcclusionPolicy: (policy) => set((s) => ({ occlusionPolicy: { ...s.occlusionPolicy, ...policy } })),
    focusNode: (nodeId) => set({ focusedNodeId: nodeId }),
    openOverlay: (overlay) =>
      set((s) => ({ overlays: [...s.overlays.filter((o) => o.id !== overlay.id), overlay] })),
    closeOverlay: (id) => set((s) => ({ overlays: s.overlays.filter((o) => o.id !== id) }))
  }))
)

// Debounced persistence: any tree change saves ~300ms later under the bound
// task id. Decouples persistence from individual actions (resize updates the
// tree live every frame but only writes once the drag settles).
let saveTimer: ReturnType<typeof setTimeout> | null = null
useLayoutStore.subscribe(
  (s) => s.tree,
  (tree) => {
    const { taskId } = useLayoutStore.getState()
    if (!taskId) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveTree(taskId, tree), 300)
  }
)

// ── selector hooks (public API) ──────────────────────────────────────────────
export const useLayoutTree = (): LayoutTree => useLayoutStore((s) => s.tree)
export const useOverlays = (): Overlay[] => useLayoutStore((s) => s.overlays)
export const useFocusedNodeId = (): string | null => useLayoutStore((s) => s.focusedNodeId)
export const useDraggingSplitId = (): string | null => useLayoutStore((s) => s.draggingSplitId)
export const useNativeTilesVisible = (): boolean =>
  useLayoutStore((s) =>
    nativeTileVisible(s.occlusionPolicy, { overlays: s.overlays, draggingSplitId: s.draggingSplitId })
  )
export const getLayoutStore = (): LayoutStore => useLayoutStore.getState()

// Debug/e2e handle (mirrors window.__slayzone_terminalStateStore).
if (typeof window !== 'undefined') {
  ;(window as unknown as { __slayzone_layoutStore?: typeof useLayoutStore }).__slayzone_layoutStore =
    useLayoutStore
}
