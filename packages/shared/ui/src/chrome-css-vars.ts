import type { ChromeColors } from '@slayzone/theme-tokens'

/**
 * The DOM side of the theme presets (`@slayzone/theme-tokens`): each chrome colour
 * becomes a CSS variable on <html>, which the Tailwind theme tokens read. The
 * presets' original CSS colour strings are painted as-is.
 */

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
  ['--surface-3', 'surface3'],
  ['--modal', 'modal'],
  ['--modal-border', 'modalBorder'],
  ['--success', 'success'],
  ['--success-foreground', 'successForeground'],
  ['--success-emphasis', 'successEmphasis'],
  ['--success-contrast', 'successContrast'],
  ['--warning', 'warning'],
  ['--warning-foreground', 'warningForeground'],
  ['--warning-emphasis', 'warningEmphasis'],
  ['--warning-contrast', 'warningContrast'],
  ['--info', 'info'],
  ['--info-foreground', 'infoForeground'],
  ['--info-emphasis', 'infoEmphasis'],
  ['--info-contrast', 'infoContrast'],
  ['--agent', 'agent'],
  ['--agent-foreground', 'agentForeground'],
  ['--agent-emphasis', 'agentEmphasis'],
  ['--agent-contrast', 'agentContrast'],
  ['--diff-added', 'diffAdded'],
  ['--diff-added-foreground', 'diffAddedForeground'],
  ['--diff-removed', 'diffRemoved'],
  ['--diff-removed-foreground', 'diffRemovedForeground']
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
