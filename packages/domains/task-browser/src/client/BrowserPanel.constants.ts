import { Monitor, Smartphone, Tablet } from 'lucide-react'
import type { BrowserTabTheme, DeviceSlot } from '../shared'

export const SLOT_BUTTONS: { slot: DeviceSlot; icon: typeof Monitor; label: string }[] = [
  { slot: 'desktop', icon: Monitor, label: 'Desktop' },
  { slot: 'tablet', icon: Tablet, label: 'Tablet' },
  { slot: 'mobile', icon: Smartphone, label: 'Mobile' }
]

export const THEME_CSS: Record<'light' | 'dark', string> = {
  dark: [
    'html{filter:invert(90%) hue-rotate(180deg)!important}',
    'img,video,canvas,svg,iframe{filter:invert(90%) hue-rotate(180deg)!important}'
  ].join(''),
  light: ':root{color-scheme:light!important}'
}

export const THEME_CYCLE: BrowserTabTheme[] = ['system', 'dark', 'light']
export const EXTENSIONS_MANAGER_ENABLED = false
