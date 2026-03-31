import type { UnifiedThemeDefinition, UnifiedThemeVariant, ChromeColors, TerminalThemeColors, EditorThemeColors } from '../theme-types'
import { slay } from './slay'
import { slaySpecial } from './slay-special'
import { trueBlack } from './true-black'
import { ghostty } from './ghostty'
import { catppuccin } from './catppuccin'
import { dracula } from './dracula'
import { tokyoNight } from './tokyo-night'
import { gruvbox } from './gruvbox'
import { nord } from './nord'
import { solarized } from './solarized'
import { oneDark } from './one-dark'
import { rosePine } from './rose-pine'
import { kanagawa } from './kanagawa'
import { vscode } from './vscode'

export const unifiedThemes: UnifiedThemeDefinition[] = [
  slay,
  slaySpecial,
  trueBlack,
  ghostty,
  catppuccin,
  dracula,
  tokyoNight,
  gruvbox,
  nord,
  solarized,
  oneDark,
  rosePine,
  kanagawa,
  vscode,
]

const themeMap = new Map(unifiedThemes.map(t => [t.id, t]))

export function getUnifiedTheme(id: string): UnifiedThemeDefinition {
  return themeMap.get(id) ?? slay
}

export function getThemeVariant(id: string, variant: 'dark' | 'light'): UnifiedThemeVariant {
  const theme = getUnifiedTheme(id)
  return (variant === 'dark' ? theme.dark : theme.light) ?? theme.dark ?? slay.dark!
}

export function getThemeChrome(id: string, variant: 'dark' | 'light'): ChromeColors {
  return getThemeVariant(id, variant).chrome
}

export function getThemeTerminalColors(id: string, variant: 'dark' | 'light'): TerminalThemeColors {
  return getThemeVariant(id, variant).terminal
}

export function getThemeEditorColors(id: string, variant: 'dark' | 'light'): EditorThemeColors {
  return getThemeVariant(id, variant).editor
}

/** CSS variable name to ChromeColors key mapping */
const chromeVarMap: [string, keyof ChromeColors][] = [
  ['--background', 'background'],
  ['--foreground', 'foreground'],
  ['--card', 'card'],
  ['--card-foreground', 'cardForeground'],
  ['--popover', 'popover'],
  ['--popover-foreground', 'popoverForeground'],
  ['--primary', 'primary'],
  ['--primary-foreground', 'primaryForeground'],
  ['--secondary', 'secondary'],
  ['--secondary-foreground', 'secondaryForeground'],
  ['--muted', 'muted'],
  ['--muted-foreground', 'mutedForeground'],
  ['--accent', 'accent'],
  ['--accent-foreground', 'accentForeground'],
  ['--destructive', 'destructive'],
  ['--border', 'border'],
  ['--input', 'input'],
  ['--ring', 'ring'],
  ['--chart-1', 'chart1'],
  ['--chart-2', 'chart2'],
  ['--chart-3', 'chart3'],
  ['--chart-4', 'chart4'],
  ['--chart-5', 'chart5'],
  ['--sidebar', 'sidebar'],
  ['--sidebar-foreground', 'sidebarForeground'],
  ['--sidebar-primary', 'sidebarPrimary'],
  ['--sidebar-primary-foreground', 'sidebarPrimaryForeground'],
  ['--sidebar-accent', 'sidebarAccent'],
  ['--sidebar-accent-foreground', 'sidebarAccentForeground'],
  ['--sidebar-border', 'sidebarBorder'],
  ['--sidebar-ring', 'sidebarRing'],
  ['--surface-0', 'surface0'],
  ['--surface-1', 'surface1'],
  ['--surface-2', 'surface2'],
  ['--modal', 'modal'],
  ['--modal-border', 'modalBorder'],
]

export function applyChromeColors(chrome: ChromeColors): void {
  const root = document.documentElement
  for (const [varName, key] of chromeVarMap) {
    root.style.setProperty(varName, chrome[key])
  }
}

/** Returns chrome CSS vars as a React CSSProperties object for inline style overrides */
export function getChromeStyleOverrides(chrome: ChromeColors): Record<string, string> {
  const style: Record<string, string> = {}
  for (const [varName, key] of chromeVarMap) {
    style[varName] = chrome[key]
  }
  return style
}

export function clearChromeColors(): void {
  const root = document.documentElement
  for (const [varName] of chromeVarMap) {
    root.style.removeProperty(varName)
  }
}

export type { UnifiedThemeDefinition, UnifiedThemeVariant, ChromeColors, TerminalThemeColors, EditorThemeColors }
