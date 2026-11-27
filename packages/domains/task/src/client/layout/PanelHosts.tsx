import { createContext, use, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PanelPlacement } from './strip'

/**
 * Panels survive moves between groups (docs/plans/panel-model.md step 7).
 *
 * Each rendered instance renders ONCE, keyed by its id, through a portal into its
 * own host node (`PanelNodePool`). The column tree only renders a `PanelTarget` where
 * the panel belongs; the target adopts the instance's host node into itself. Moving
 * a tab to another group, merging or splitting it re-renders the tree, which moves
 * the host node to the new target: the DOM moves, React never remounts the panel —
 * the terminal keeps its session attached, the browser keeps its WebContentsView
 * (positioned from the DOM box, so it just follows).
 *
 * Host nodes and targets are `display: contents`, so a Classic panel's frame is
 * still a flex item of the strip and lays out exactly as before.
 *
 * Caveat: DOM that reloads when moved (a <webview> or <iframe> inside a panel: the
 * browser's multi-device mode, an artifact's HTML preview) still reloads on a move.
 */
export class PanelNodePool {
  private readonly nodes = new Map<string, HTMLElement>()

  /** The instance's host node (made on first use; stable while the instance renders). */
  node(instanceId: string): HTMLElement {
    let node = this.nodes.get(instanceId)
    if (!node) {
      node = document.createElement('div')
      node.style.display = 'contents'
      node.dataset.panelHost = instanceId
      this.nodes.set(instanceId, node)
    }
    return node
  }

  /** A target mounted: adopt the instance's host node. */
  attach(instanceId: string, target: HTMLElement): void {
    const node = this.node(instanceId)
    if (node.parentNode !== target) target.appendChild(node)
  }

  /** A target unmounted: let go of the host node unless another target adopted it already. */
  detach(instanceId: string, target: HTMLElement): void {
    const node = this.nodes.get(instanceId)
    if (node?.parentNode === target) target.removeChild(node)
  }

  /** Forget the host nodes of instances no longer rendered (their panels unmounted). */
  retain(instanceIds: ReadonlySet<string>): void {
    for (const [id, node] of this.nodes) {
      if (instanceIds.has(id)) continue
      node.remove()
      this.nodes.delete(id)
    }
  }
}

export const PanelNodePoolContext = createContext<PanelNodePool | null>(null)

/** Where instance `instanceId`'s panel shows in the column tree. */
export function PanelTarget({ instanceId }: { instanceId: string }): React.JSX.Element {
  const pool = use(PanelNodePoolContext)
  // Stable: a new ref callback would detach and re-adopt the host node on every render.
  const adopt = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el || !pool) return
      pool.attach(instanceId, el)
      return () => pool.detach(instanceId, el)
    },
    [pool, instanceId]
  )
  return <div className="contents" data-panel-target={instanceId} ref={adopt} />
}

/** Renders one placed panel (its content goes into the instance's host node). */
export type RenderPlacedPanel = (placement: PanelPlacement) => ReactNode

function PanelHost({
  placement,
  pool,
  render
}: {
  placement: PanelPlacement
  pool: PanelNodePool
  render: RenderPlacedPanel
}): React.JSX.Element {
  return createPortal(render(placement), pool.node(placement.instance.id), placement.instance.id)
}

/**
 * Every placed panel, once each, keyed by instance id, portaled into its host node.
 * Render it AFTER the column tree: the targets then adopt the host nodes (refs run in
 * tree order) before the panels' own layout effects measure anything.
 */
export function PanelHosts({
  placements,
  pool,
  render
}: {
  placements: readonly PanelPlacement[]
  pool: PanelNodePool
  render: RenderPlacedPanel
}): React.JSX.Element {
  return (
    <>
      {placements.map((p) => (
        <PanelHost key={p.instance.id} placement={p} pool={pool} render={render} />
      ))}
    </>
  )
}
