import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TaskDetailsView } from './TaskDetailsView'

// window.api shim is installed by the shell before this module evaluates
// (see @slayzone/chromium-shell src/main.tsx), so feature code added here can
// read window.api safely.
export function mountApp(): void {
  const el = document.getElementById('root')
  if (!el) throw new Error('[renderer-app] #root element not found')
  createRoot(el).render(
    <StrictMode>
      <TaskDetailsView />
    </StrictMode>
  )
}
