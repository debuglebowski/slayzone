import type {
  UnifiedThemeDefinition,
  UnifiedThemeVariant,
  ChromeColors,
  TerminalThemeColors,
  EditorThemeColors
} from '../types'
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

/** Every preset, in the order the theme pickers list them. */
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
  vscode
]

const themeMap = new Map(unifiedThemes.map((t) => [t.id, t]))

/** The preset with this id; an unknown id gets `slay`. */
export function getUnifiedTheme(id: string): UnifiedThemeDefinition {
  return themeMap.get(id) ?? slay
}

/** One variant of a preset; a preset without a light variant answers with its dark one. */
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
