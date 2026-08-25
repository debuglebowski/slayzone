import { Monitor, Smartphone, Tablet } from 'lucide-react'
import { FORCED_HTML_THEME_CSS } from '@slayzone/platform/html-theme-css'
import type { BrowserTabTheme, DeviceSlot } from '../shared'

export const SLOT_BUTTONS: { slot: DeviceSlot; icon: typeof Monitor; label: string }[] = [
  { slot: 'desktop', icon: Monitor, label: 'Desktop' },
  { slot: 'tablet', icon: Tablet, label: 'Tablet' },
  { slot: 'mobile', icon: Smartphone, label: 'Mobile' }
]

// Shared with task-artifacts' HTML preview theme override — single source of
// truth for the "force a color scheme onto content you don't control" CSS.
export const THEME_CSS = FORCED_HTML_THEME_CSS

export const THEME_CYCLE: BrowserTabTheme[] = ['system', 'dark', 'light']
export const EXTENSIONS_MANAGER_ENABLED = false
