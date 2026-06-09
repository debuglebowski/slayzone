// The overlay plane — renders dialogs/menus/popups via a portal to document.body
// so they escape the layout container's stacking and sit above everything
// (including, with a real native surface, the native plane). Click-scrim closes.
import { createPortal } from 'react-dom'
import type { Overlay } from './types'
import { getLayoutStore, useOverlays } from './store'
import { COLORS } from './colors'

export function OverlayLayer() {
  const overlays = useOverlays()
  if (typeof document === 'undefined' || overlays.length === 0) return null
  return createPortal(
    overlays.map((o) => <OverlayHost key={o.id} overlay={o} />),
    document.body
  )
}

function OverlayHost({ overlay }: { overlay: Overlay }) {
  const close = (): void => getLayoutStore().closeOverlay(overlay.id)

  if (overlay.kind === 'dialog') {
    return (
      <div
        data-testid="overlay-scrim"
        onMouseDown={close}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1000,
          background: COLORS.overlayScrim,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            minWidth: 320,
            maxWidth: '80vw',
            padding: 20,
            borderRadius: 10,
            background: COLORS.panelBg,
            border: `1px solid ${COLORS.border}`,
            color: COLORS.text,
            font: '13px ui-sans-serif, system-ui, sans-serif'
          }}
        >
          {overlay.render()}
        </div>
      </div>
    )
  }

  // menu / popup — positioned at anchorRect if supplied
  const r = overlay.anchorRect
  return (
    <div
      style={{
        position: 'fixed',
        zIndex: 1000,
        left: r ? r.x : 0,
        top: r ? r.y + r.h : 0,
        background: COLORS.panelBg,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 8,
        color: COLORS.text,
        font: '13px ui-sans-serif, system-ui, sans-serif'
      }}
    >
      {overlay.render()}
    </div>
  )
}
