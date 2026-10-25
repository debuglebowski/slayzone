import { Monitor, Smartphone, Tablet } from 'lucide-react'
import { HTML_THEME_CYCLE } from '@slayzone/platform/forced-html-theme'
import type { BrowserTabTheme, DeviceSlot } from '../shared'

export const SLOT_BUTTONS: { slot: DeviceSlot; icon: typeof Monitor; label: string }[] = [
  { slot: 'desktop', icon: Monitor, label: 'Desktop' },
  { slot: 'tablet', icon: Tablet, label: 'Tablet' },
  { slot: 'mobile', icon: Smartphone, label: 'Mobile' }
]

// Shared with task-artifacts' HTML preview theme override, so the two toggles
// cannot drift apart.
export const THEME_CYCLE = HTML_THEME_CYCLE as readonly BrowserTabTheme[]
// Extensions manager UI: off until MV3 password managers work end to end (1Password
// still renders an empty page in Electron). Web Store installs work without it.
export const EXTENSIONS_MANAGER_ENABLED = false
