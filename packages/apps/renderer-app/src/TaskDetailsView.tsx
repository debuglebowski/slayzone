// Temporary TaskDetailsView for the chromium-shell skeleton — mirrors the real
// app's layout (packages/domains/task/src/client/TaskDetailPage.tsx): a title
// header with a panel-toggle bar, then panels laid out HORIZONTALLY. Placeholder
// panels, no resizing. Inline styles for now (no theme system in the stub yet).
import { useState } from 'react'

interface PanelDef {
  id: string
  label: string
  glyph: string
}

// Mirrors the real panel set (terminal=Agent, diff=Git, etc.).
const PANELS: PanelDef[] = [
  { id: 'terminal', label: 'Agent', glyph: '›_' },
  { id: 'browser', label: 'Browser', glyph: '◍' },
  { id: 'editor', label: 'Editor', glyph: '</>' },
  { id: 'artifacts', label: 'Artifacts', glyph: '▤' },
  { id: 'diff', label: 'Git', glyph: '⑂' },
  { id: 'settings', label: 'Settings', glyph: '⚙' }
]

const C = {
  bg: '#0e0e10',
  panelBg: '#141417',
  border: '#26262c',
  barBg: '#161619',
  text: '#e5e5e5',
  muted: '#8a8a92',
  faint: '#5a5a62',
  activeBg: '#2a2a33',
  accent: '#7c7cf0'
}

function PanelToggle({
  active,
  onToggle
}: {
  active: Set<string>
  onToggle: (id: string) => void
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: 4,
        borderRadius: 10,
        background: C.barBg,
        border: `1px solid ${C.border}`
      }}
    >
      {PANELS.map((p) => {
        const on = active.has(p.id)
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onToggle(p.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              border: 'none',
              borderRadius: 7,
              cursor: 'pointer',
              font: '12px ui-sans-serif, system-ui, sans-serif',
              fontWeight: 500,
              background: on ? C.activeBg : 'transparent',
              color: on ? C.text : C.muted
            }}
          >
            <span style={{ font: '12px ui-monospace, monospace', color: on ? C.accent : C.faint }}>
              {p.glyph}
            </span>
            {p.label}
          </button>
        )
      })}
    </div>
  )
}

function PanelCard({ label }: { label: string }): React.JSX.Element {
  return (
    <div
      data-panel-id={label}
      style={{
        flex: '1 1 0',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        border: `1px solid ${C.border}`,
        borderRadius: 8,
        background: C.panelBg,
        overflow: 'hidden'
      }}
    >
      <header
        style={{
          padding: '8px 12px',
          borderBottom: `1px solid ${C.border}`,
          fontSize: 12,
          fontWeight: 600,
          color: '#cfcfd4'
        }}
      >
        {label}
      </header>
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: C.faint,
          fontSize: 12
        }}
      >
        {label} panel — placeholder
      </div>
    </div>
  )
}

export function TaskDetailsView(): React.JSX.Element {
  const [active, setActive] = useState<Set<string>>(() => new Set(['terminal', 'browser', 'editor']))
  const toggle = (id: string): void =>
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const visible = PANELS.filter((p) => active.has(p.id))

  return (
    <div
      id="task-detail"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: C.bg,
        color: C.text,
        font: '13px ui-sans-serif, system-ui, sans-serif'
      }}
    >
      <header
        style={{
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          padding: '14px 16px'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span
            style={{
              width: 11,
              height: 11,
              borderRadius: '50%',
              border: '2px solid #e0a042',
              flex: '0 0 auto'
            }}
          />
          <span style={{ fontSize: 20, fontWeight: 700, whiteSpace: 'nowrap' }}>Sample Task</span>
          <span style={{ fontSize: 12, color: C.muted }}>· placeholder</span>
        </div>

        <PanelToggle active={active} onToggle={toggle} />
      </header>

      <div
        id="task-panels"
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          gap: 12,
          padding: 16,
          overflow: 'hidden'
        }}
      >
        {visible.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: C.faint,
              fontSize: 13
            }}
          >
            No panels — toggle one above.
          </div>
        ) : (
          visible.map((p) => <PanelCard key={p.id} label={p.label} />)
        )}
      </div>
    </div>
  )
}
