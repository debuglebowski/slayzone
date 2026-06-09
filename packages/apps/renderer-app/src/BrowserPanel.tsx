// Browser panel chrome — DOM toolbar (back/forward/reload + URL bar) above the
// framework-managed native anchor. The actual page pixels are the fork's
// embedded-tab WebContents composited at the anchor's rect.
import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { COLORS } from '@slayzone/layout'
import type { PanelProps } from '@slayzone/layout'
import type { EmbeddedTabHostApi, TabState } from './embedded-tab-host'

const btnStyle: CSSProperties = {
  border: 'none',
  borderRadius: 6,
  padding: '4px 8px',
  cursor: 'pointer',
  background: 'transparent',
  color: COLORS.muted,
  font: '13px ui-sans-serif, system-ui, sans-serif'
}

export function makeBrowserPanel(host: EmbeddedTabHostApi) {
  return function BrowserPanel({ tile, anchor }: PanelProps) {
    const [state, setState] = useState<TabState>(() => host.getState(tile.id))
    const [input, setInput] = useState(() => host.getState(tile.id).url)
    const [editing, setEditing] = useState(false)

    useEffect(() => host.onState(tile.id, setState), [tile.id])
    useEffect(() => {
      if (!editing) setInput(state.url)
    }, [state.url, editing])

    const go = (): void => {
      const raw = input.trim()
      if (!raw) return
      const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
      host.navigate(tile.id, url)
      setEditing(false)
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 6px',
            borderBottom: `1px solid ${COLORS.border}`,
            flex: '0 0 auto'
          }}
        >
          <button type="button" style={btnStyle} disabled={!state.canGoBack} onClick={() => host.goBack(tile.id)}>
            ←
          </button>
          <button type="button" style={btnStyle} disabled={!state.canGoForward} onClick={() => host.goForward(tile.id)}>
            →
          </button>
          <button type="button" style={btnStyle} onClick={() => host.reload(tile.id)}>
            {state.isLoading ? '×' : '⟳'}
          </button>
          <input
            value={input}
            onChange={(e) => {
              setEditing(true)
              setInput(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go()
            }}
            onBlur={() => setEditing(false)}
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 6,
              padding: '4px 8px',
              background: COLORS.bg,
              color: COLORS.text,
              font: '12px ui-monospace, monospace',
              outline: 'none'
            }}
          />
        </div>
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>{anchor}</div>
      </div>
    )
  }
}
