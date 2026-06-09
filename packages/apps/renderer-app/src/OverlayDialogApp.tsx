// Overlay-dialog mode — what the native overlay surface renders. This instance
// of the shell bundle is loaded by SlayzoneOverlayManager into a TRANSPARENT
// WebView composited above the live embedded tab. It must paint NO opaque
// background outside the dialog card (the scrim is intentionally translucent —
// the live browser shows through it). Modal semantics: this surface absorbs
// all input while shown; Close/ESC/scrim-click dismiss via LayoutHost.
import { useEffect } from 'react'
import { COLORS } from '@slayzone/layout'

interface NativeOverlayHook {
  show(id: string): Promise<boolean>
  close(): Promise<boolean>
}

function overlayHook(): NativeOverlayHook | null {
  return (
    (window as unknown as { __slayzoneNativeOverlay?: NativeOverlayHook }).__slayzoneNativeOverlay ?? null
  )
}

export function OverlayDialogApp() {
  const close = (): void => {
    void overlayHook()?.close()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      onMouseDown={close}
      style={{
        position: 'fixed',
        inset: 0,
        // translucent scrim — the live embedded tab is visible through this
        background: 'rgba(0, 0, 0, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        font: '13px ui-sans-serif, system-ui, sans-serif'
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          minWidth: 360,
          maxWidth: '70vw',
          padding: 20,
          borderRadius: 10,
          background: COLORS.panelBg,
          border: `1px solid ${COLORS.border}`,
          color: COLORS.text,
          boxShadow: '0 12px 48px rgba(0,0,0,0.5)'
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>Native overlay dialog</div>
        <div style={{ color: COLORS.muted, fontSize: 13, lineHeight: 1.5, marginBottom: 14 }}>
          This dialog renders on the native overlay plane — composited <em>above</em> the live embedded
          browser. The page underneath keeps playing; input is blocked while this is open (modal).
        </div>
        <button
          type="button"
          onClick={close}
          style={{
            border: `1px solid ${COLORS.border}`,
            borderRadius: 7,
            padding: '6px 14px',
            cursor: 'pointer',
            background: COLORS.activeBg,
            color: COLORS.text,
            font: '13px ui-sans-serif, system-ui, sans-serif'
          }}
        >
          Close
        </button>
      </div>
    </div>
  )
}
