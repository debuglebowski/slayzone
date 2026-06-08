import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Skeleton paint. window.api shim is already installed by the shell before this
// module evaluates (see @slayzone/shell src/main.tsx), so feature code imported
// here later can read window.api safely.
function Skeleton(): React.JSX.Element {
  return (
    <div
      style={{
        font: '14px ui-sans-serif, system-ui, sans-serif',
        minHeight: '100vh',
        padding: 32,
        color: '#e5e5e5',
        background: '#0e0e10'
      }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>SlayZone — chromium shell</h1>
      <p style={{ color: '#9a9a9a', marginTop: 8 }}>
        renderer-app skeleton. <code>window.api</code> shim installed. Import slay features here.
      </p>
    </div>
  )
}

export function mountApp(): void {
  const el = document.getElementById('root')
  if (!el) throw new Error('[renderer-app] #root element not found')
  createRoot(el).render(
    <StrictMode>
      <Skeleton />
    </StrictMode>
  )
}
