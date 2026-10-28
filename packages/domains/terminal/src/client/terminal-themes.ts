import type { ITheme } from '@xterm/xterm'
import type { Theme } from '@slayzone/ui/theme-types'

export interface TerminalThemeDefinition {
  id: string
  name: string
  variant: 'dark' | 'light'
  colors: ITheme
}

// ---------------------------------------------------------------------------
// Dark themes
// ---------------------------------------------------------------------------

const defaultDark: ITheme = {
  background: '#000000',
  foreground: '#e5e5e5',
  cursor: '#e5e5e5',
  cursorAccent: '#000000',
  selectionBackground: '#525252',
  black: '#000000',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e5e5e5',
  brightBlack: '#404040',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa'
}

const ghostty: ITheme = {
  background: '#282c34',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorAccent: '#282c34',
  selectionBackground: '#3e4451',
  black: '#1d1f21',
  red: '#bf6b69',
  green: '#b7bd73',
  yellow: '#e9c880',
  blue: '#88a1bb',
  magenta: '#ad95b8',
  cyan: '#95bdb7',
  white: '#c5c8c6',
  brightBlack: '#666666',
  brightRed: '#c55757',
  brightGreen: '#bcc95f',
  brightYellow: '#e1c65e',
  brightBlue: '#83a5d6',
  brightMagenta: '#bc99d4',
  brightCyan: '#83beb1',
  brightWhite: '#eaeaea'
}

const catppuccinMocha: ITheme = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#45475a',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#f5c2e7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8'
}

const dracula: ITheme = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#282a36',
  selectionBackground: '#44475a',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff'
}

const tokyoNight: ITheme = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#33467c',
  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',
  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5'
}

const gruvboxDark: ITheme = {
  background: '#282828',
  foreground: '#ebdbb2',
  cursor: '#ebdbb2',
  cursorAccent: '#282828',
  selectionBackground: '#504945',
  black: '#282828',
  red: '#cc241d',
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  magenta: '#b16286',
  cyan: '#689d6a',
  white: '#a89984',
  brightBlack: '#928374',
  brightRed: '#fb4934',
  brightGreen: '#b8bb26',
  brightYellow: '#fabd2f',
  brightBlue: '#83a598',
  brightMagenta: '#d3869b',
  brightCyan: '#8ec07c',
  brightWhite: '#ebdbb2'
}

const nord: ITheme = {
  background: '#2e3440',
  foreground: '#d8dee9',
  cursor: '#d8dee9',
  cursorAccent: '#2e3440',
  selectionBackground: '#434c5e',
  black: '#3b4252',
  red: '#bf616a',
  green: '#a3be8c',
  yellow: '#ebcb8b',
  blue: '#81a1c1',
  magenta: '#b48ead',
  cyan: '#88c0d0',
  white: '#e5e9f0',
  brightBlack: '#4c566a',
  brightRed: '#bf616a',
  brightGreen: '#a3be8c',
  brightYellow: '#ebcb8b',
  brightBlue: '#81a1c1',
  brightMagenta: '#b48ead',
  brightCyan: '#8fbcbb',
  brightWhite: '#eceff4'
}

const solarizedDark: ITheme = {
  background: '#002b36',
  foreground: '#839496',
  cursor: '#839496',
  cursorAccent: '#002b36',
  selectionBackground: '#073642',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3'
}

const oneDark: ITheme = {
  background: '#282c34',
  foreground: '#abb2bf',
  cursor: '#528bff',
  cursorAccent: '#282c34',
  selectionBackground: '#3e4451',
  black: '#282c34',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff'
}

const rosePine: ITheme = {
  background: '#191724',
  foreground: '#e0def4',
  cursor: '#524f67',
  cursorAccent: '#e0def4',
  selectionBackground: '#2a283e',
  black: '#26233a',
  red: '#eb6f92',
  green: '#31748f',
  yellow: '#f6c177',
  blue: '#9ccfd8',
  magenta: '#c4a7e7',
  cyan: '#ebbcba',
  white: '#e0def4',
  brightBlack: '#6e6a86',
  brightRed: '#eb6f92',
  brightGreen: '#31748f',
  brightYellow: '#f6c177',
  brightBlue: '#9ccfd8',
  brightMagenta: '#c4a7e7',
  brightCyan: '#ebbcba',
  brightWhite: '#e0def4'
}

const kanagawa: ITheme = {
  background: '#1f1f28',
  foreground: '#dcd7ba',
  cursor: '#c8c093',
  cursorAccent: '#1f1f28',
  selectionBackground: '#2d4f67',
  black: '#16161d',
  red: '#c34043',
  green: '#76946a',
  yellow: '#c0a36e',
  blue: '#7e9cd8',
  magenta: '#957fb8',
  cyan: '#6a9589',
  white: '#c8c093',
  brightBlack: '#727169',
  brightRed: '#e82424',
  brightGreen: '#98bb6c',
  brightYellow: '#e6c384',
  brightBlue: '#7fb4ca',
  brightMagenta: '#938aa9',
  brightCyan: '#7aa89f',
  brightWhite: '#dcd7ba'
}

const slay: ITheme = {
  background: '#141418',
  foreground: '#d4d4d8',
  cursor: '#a1a1aa',
  cursorAccent: '#141418',
  selectionBackground: '#3f3f46',
  black: '#18181b',
  red: '#f87171',
  green: '#6ee7b7',
  yellow: '#fcd34d',
  blue: '#93c5fd',
  magenta: '#c4b5fd',
  cyan: '#67e8f9',
  white: '#d4d4d8',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#a7f3d0',
  brightYellow: '#fde68a',
  brightBlue: '#bfdbfe',
  brightMagenta: '#ddd6fe',
  brightCyan: '#a5f3fc',
  brightWhite: '#fafafa'
}

const slaySpecial: ITheme = {
  background: '#331100',
  foreground: '#ffddaa',
  cursor: '#ff0000',
  cursorAccent: '#000000',
  selectionBackground: '#ff000050',
  black: '#1a0000',
  red: '#ff0000',
  green: '#00ff00',
  yellow: '#ffff00',
  blue: '#00aaff',
  magenta: '#ff00ff',
  cyan: '#ff6600',
  white: '#ffaa00',
  brightBlack: '#804000',
  brightRed: '#ff4444',
  brightGreen: '#44ff44',
  brightYellow: '#ffff44',
  brightBlue: '#44ccff',
  brightMagenta: '#ff44ff',
  brightCyan: '#ff8833',
  brightWhite: '#ffffff'
}

// ---------------------------------------------------------------------------
// Light themes
// ---------------------------------------------------------------------------

const slayLight: ITheme = {
  background: '#f4f4f5',
  foreground: '#27272a',
  cursor: '#52525b',
  cursorAccent: '#f4f4f5',
  selectionBackground: '#d4d4d8',
  black: '#18181b',
  red: '#dc2626',
  green: '#059669',
  yellow: '#b45309',
  blue: '#2563eb',
  magenta: '#7c3aed',
  cyan: '#0891b2',
  white: '#d4d4d8',
  brightBlack: '#71717a',
  brightRed: '#ef4444',
  brightGreen: '#10b981',
  brightYellow: '#d97706',
  brightBlue: '#3b82f6',
  brightMagenta: '#8b5cf6',
  brightCyan: '#06b6d4',
  brightWhite: '#52525b'
}

const slaySpecialLight: ITheme = {
  background: '#ffeecc',
  foreground: '#441100',
  cursor: '#ff0000',
  cursorAccent: '#ffffff',
  selectionBackground: '#ff000030',
  black: '#440000',
  red: '#ee0000',
  green: '#008800',
  yellow: '#cc6600',
  blue: '#0044dd',
  magenta: '#dd0088',
  cyan: '#cc4400',
  white: '#ffddaa',
  brightBlack: '#884400',
  brightRed: '#ff0000',
  brightGreen: '#00bb00',
  brightYellow: '#ff6600',
  brightBlue: '#0066ff',
  brightMagenta: '#ff0088',
  brightCyan: '#ff5500',
  brightWhite: '#440000'
}

const defaultLight: ITheme = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#1a1a1a',
  cursorAccent: '#ffffff',
  selectionBackground: '#b4d5fe',
  black: '#1a1a1a',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#a16207',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0e7490',
  white: '#4b5563',
  brightBlack: '#9ca3af',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#6b7280'
}

const catppuccinLatte: ITheme = {
  background: '#eff1f5',
  foreground: '#4c4f69',
  cursor: '#dc8a78',
  cursorAccent: '#eff1f5',
  selectionBackground: '#acb0be',
  black: '#5c5f77',
  red: '#d20f39',
  green: '#40a02b',
  yellow: '#df8e1d',
  blue: '#1e66f5',
  magenta: '#ea76cb',
  cyan: '#179299',
  white: '#acb0be',
  brightBlack: '#6c6f85',
  brightRed: '#d20f39',
  brightGreen: '#40a02b',
  brightYellow: '#df8e1d',
  brightBlue: '#1e66f5',
  brightMagenta: '#ea76cb',
  brightCyan: '#179299',
  brightWhite: '#bcc0cc'
}

const solarizedLight: ITheme = {
  background: '#fdf6e3',
  foreground: '#657b83',
  cursor: '#657b83',
  cursorAccent: '#fdf6e3',
  selectionBackground: '#eee8d5',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#586e75',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3'
}

const tokyoNightLight: ITheme = {
  background: '#d5d6db',
  foreground: '#343b58',
  cursor: '#343b58',
  cursorAccent: '#d5d6db',
  selectionBackground: '#9699a3',
  black: '#0f0f14',
  red: '#8c4351',
  green: '#485e30',
  yellow: '#8f5e15',
  blue: '#34548a',
  magenta: '#5a4a78',
  cyan: '#0f4b6e',
  white: '#343b58',
  brightBlack: '#9699a3',
  brightRed: '#8c4351',
  brightGreen: '#485e30',
  brightYellow: '#8f5e15',
  brightBlue: '#34548a',
  brightMagenta: '#5a4a78',
  brightCyan: '#0f4b6e',
  brightWhite: '#343b58'
}

const rosePineDawn: ITheme = {
  background: '#faf4ed',
  foreground: '#575279',
  cursor: '#9893a5',
  cursorAccent: '#575279',
  selectionBackground: '#dfdad9',
  black: '#f2e9e1',
  red: '#b4637a',
  green: '#286983',
  yellow: '#ea9d34',
  blue: '#56949f',
  magenta: '#907aa9',
  cyan: '#d7827e',
  white: '#575279',
  brightBlack: '#9893a5',
  brightRed: '#b4637a',
  brightGreen: '#286983',
  brightYellow: '#ea9d34',
  brightBlue: '#56949f',
  brightMagenta: '#907aa9',
  brightCyan: '#d7827e',
  brightWhite: '#575279'
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const terminalThemes: TerminalThemeDefinition[] = [
  // Dark
  { id: 'slay', name: 'Slay', variant: 'dark', colors: slay },
  { id: 'slay-special', name: 'Slay Special', variant: 'dark', colors: slaySpecial },
  { id: 'default-dark', name: 'True Black', variant: 'dark', colors: defaultDark },
  { id: 'ghostty', name: 'Ghostty', variant: 'dark', colors: ghostty },
  { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', variant: 'dark', colors: catppuccinMocha },
  { id: 'dracula', name: 'Dracula', variant: 'dark', colors: dracula },
  { id: 'tokyo-night', name: 'Tokyo Night', variant: 'dark', colors: tokyoNight },
  { id: 'gruvbox-dark', name: 'Gruvbox', variant: 'dark', colors: gruvboxDark },
  { id: 'nord', name: 'Nord', variant: 'dark', colors: nord },
  { id: 'solarized-dark', name: 'Solarized', variant: 'dark', colors: solarizedDark },
  { id: 'one-dark', name: 'One Dark', variant: 'dark', colors: oneDark },
  { id: 'rose-pine', name: 'Rosé Pine', variant: 'dark', colors: rosePine },
  { id: 'kanagawa', name: 'Kanagawa', variant: 'dark', colors: kanagawa },
  // Light
  { id: 'slay-light', name: 'Slay', variant: 'light', colors: slayLight },
  { id: 'slay-special-light', name: 'Slay Special', variant: 'light', colors: slaySpecialLight },
  { id: 'default-light', name: 'True White', variant: 'light', colors: defaultLight },
  { id: 'catppuccin-latte', name: 'Catppuccin Latte', variant: 'light', colors: catppuccinLatte },
  { id: 'solarized-light', name: 'Solarized', variant: 'light', colors: solarizedLight },
  { id: 'tokyo-night-light', name: 'Tokyo Night', variant: 'light', colors: tokyoNightLight },
  { id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', variant: 'light', colors: rosePineDawn }
]

export const darkThemes = terminalThemes.filter((t) => t.variant === 'dark')
export const lightThemes = terminalThemes.filter((t) => t.variant === 'light')

export function getTerminalThemeById(id: string): ITheme {
  return terminalThemes.find((t) => t.id === id)?.colors ?? slay
}

export function getTerminalTheme(
  appTheme: Theme,
  terminalThemeDark: string,
  terminalThemeLight: string
): ITheme {
  const id = appTheme === 'dark' ? terminalThemeDark : terminalThemeLight
  return getTerminalThemeById(id)
}
