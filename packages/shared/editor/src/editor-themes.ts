type Theme = 'light' | 'dark'

export interface EditorThemeColors {
  // Chrome
  background: string
  foreground: string
  selection: string
  cursor: string
  gutterBackground: string
  gutterForeground: string
  lineHighlight: string
  // Syntax tokens
  keyword: string
  string: string
  comment: string
  number: string
  function: string
  type: string
  operator: string
  variable: string
  property: string
  link: string
  heading: string
}

export interface EditorThemeDefinition {
  id: string
  name: string
  variant: 'dark' | 'light'
  colors: EditorThemeColors
}

// ---------------------------------------------------------------------------
// Dark themes
// ---------------------------------------------------------------------------

const slay: EditorThemeColors = {
  background: '#141418',
  foreground: '#d4d4d8',
  selection: '#3f3f46',
  cursor: '#a1a1aa',
  gutterBackground: '#141418',
  gutterForeground: '#52525b',
  lineHighlight: '#1c1c22',
  keyword: '#c084fc',
  string: '#6ee7b7',
  comment: '#52525b',
  number: '#fcd34d',
  function: '#93c5fd',
  type: '#67e8f9',
  operator: '#a1a1aa',
  variable: '#d4d4d8',
  property: '#f87171',
  link: '#93c5fd',
  heading: '#c4b5fd',
}

const slaySpecial: EditorThemeColors = {
  background: '#331100',
  foreground: '#ffddaa',
  selection: '#ff000050',
  cursor: '#ff0000',
  gutterBackground: '#331100',
  gutterForeground: '#804000',
  lineHighlight: '#441a00',
  keyword: '#ff0000',
  string: '#00ff00',
  comment: '#804000',
  number: '#ffff00',
  function: '#00aaff',
  type: '#ff6600',
  operator: '#ffaa00',
  variable: '#ffddaa',
  property: '#ff00ff',
  link: '#00aaff',
  heading: '#ff4444',
}

const defaultDark: EditorThemeColors = {
  background: '#000000',
  foreground: '#e5e5e5',
  selection: '#525252',
  cursor: '#e5e5e5',
  gutterBackground: '#000000',
  gutterForeground: '#404040',
  lineHighlight: '#0a0a0a',
  keyword: '#c084fc',
  string: '#4ade80',
  comment: '#404040',
  number: '#facc15',
  function: '#60a5fa',
  type: '#22d3ee',
  operator: '#a1a1aa',
  variable: '#e5e5e5',
  property: '#f87171',
  link: '#60a5fa',
  heading: '#d8b4fe',
}

const ghostty: EditorThemeColors = {
  background: '#282c34',
  foreground: '#abb2bf',
  selection: '#3e4451',
  cursor: '#528bff',
  gutterBackground: '#282c34',
  gutterForeground: '#636d83',
  lineHighlight: '#2c313c',
  keyword: '#c678dd',
  string: '#98c379',
  comment: '#5c6370',
  number: '#d19a66',
  function: '#61afef',
  type: '#e5c07b',
  operator: '#56b6c2',
  variable: '#abb2bf',
  property: '#e06c75',
  link: '#61afef',
  heading: '#e06c75',
}

const catppuccinMocha: EditorThemeColors = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  selection: '#45475a',
  cursor: '#f5e0dc',
  gutterBackground: '#1e1e2e',
  gutterForeground: '#6c7086',
  lineHighlight: '#252536',
  keyword: '#cba6f7',
  string: '#a6e3a1',
  comment: '#6c7086',
  number: '#fab387',
  function: '#89b4fa',
  type: '#f9e2af',
  operator: '#89dceb',
  variable: '#cdd6f4',
  property: '#f38ba8',
  link: '#89b4fa',
  heading: '#cba6f7',
}

const dracula: EditorThemeColors = {
  background: '#282a36',
  foreground: '#f8f8f2',
  selection: '#44475a',
  cursor: '#f8f8f2',
  gutterBackground: '#282a36',
  gutterForeground: '#6272a4',
  lineHighlight: '#2e303e',
  keyword: '#ff79c6',
  string: '#f1fa8c',
  comment: '#6272a4',
  number: '#bd93f9',
  function: '#50fa7b',
  type: '#8be9fd',
  operator: '#ff79c6',
  variable: '#f8f8f2',
  property: '#66d9ef',
  link: '#8be9fd',
  heading: '#bd93f9',
}

const tokyoNight: EditorThemeColors = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  selection: '#33467c',
  cursor: '#c0caf5',
  gutterBackground: '#1a1b26',
  gutterForeground: '#3b4261',
  lineHighlight: '#1e2030',
  keyword: '#bb9af7',
  string: '#9ece6a',
  comment: '#565f89',
  number: '#ff9e64',
  function: '#7aa2f7',
  type: '#2ac3de',
  operator: '#89ddff',
  variable: '#c0caf5',
  property: '#73daca',
  link: '#7aa2f7',
  heading: '#bb9af7',
}

const gruvboxDark: EditorThemeColors = {
  background: '#282828',
  foreground: '#ebdbb2',
  selection: '#504945',
  cursor: '#ebdbb2',
  gutterBackground: '#282828',
  gutterForeground: '#665c54',
  lineHighlight: '#2e2e2e',
  keyword: '#fb4934',
  string: '#b8bb26',
  comment: '#928374',
  number: '#d3869b',
  function: '#fabd2f',
  type: '#83a598',
  operator: '#fe8019',
  variable: '#ebdbb2',
  property: '#8ec07c',
  link: '#83a598',
  heading: '#fabd2f',
}

const nord: EditorThemeColors = {
  background: '#2e3440',
  foreground: '#d8dee9',
  selection: '#434c5e',
  cursor: '#d8dee9',
  gutterBackground: '#2e3440',
  gutterForeground: '#4c566a',
  lineHighlight: '#333a47',
  keyword: '#81a1c1',
  string: '#a3be8c',
  comment: '#616e88',
  number: '#b48ead',
  function: '#88c0d0',
  type: '#8fbcbb',
  operator: '#81a1c1',
  variable: '#d8dee9',
  property: '#d08770',
  link: '#88c0d0',
  heading: '#81a1c1',
}

const solarizedDark: EditorThemeColors = {
  background: '#002b36',
  foreground: '#839496',
  selection: '#073642',
  cursor: '#839496',
  gutterBackground: '#002b36',
  gutterForeground: '#586e75',
  lineHighlight: '#003340',
  keyword: '#859900',
  string: '#2aa198',
  comment: '#586e75',
  number: '#d33682',
  function: '#268bd2',
  type: '#b58900',
  operator: '#839496',
  variable: '#839496',
  property: '#268bd2',
  link: '#268bd2',
  heading: '#cb4b16',
}

const oneDark: EditorThemeColors = {
  background: '#282c34',
  foreground: '#abb2bf',
  selection: '#3e4451',
  cursor: '#528bff',
  gutterBackground: '#282c34',
  gutterForeground: '#636d83',
  lineHighlight: '#2c313c',
  keyword: '#c678dd',
  string: '#98c379',
  comment: '#5c6370',
  number: '#d19a66',
  function: '#61afef',
  type: '#e5c07b',
  operator: '#56b6c2',
  variable: '#abb2bf',
  property: '#e06c75',
  link: '#61afef',
  heading: '#e06c75',
}

const rosePine: EditorThemeColors = {
  background: '#191724',
  foreground: '#e0def4',
  selection: '#2a283e',
  cursor: '#524f67',
  gutterBackground: '#191724',
  gutterForeground: '#6e6a86',
  lineHighlight: '#1f1d2e',
  keyword: '#31748f',
  string: '#f6c177',
  comment: '#6e6a86',
  number: '#eb6f92',
  function: '#9ccfd8',
  type: '#c4a7e7',
  operator: '#31748f',
  variable: '#e0def4',
  property: '#ebbcba',
  link: '#9ccfd8',
  heading: '#c4a7e7',
}

const kanagawa: EditorThemeColors = {
  background: '#1f1f28',
  foreground: '#dcd7ba',
  selection: '#2d4f67',
  cursor: '#c8c093',
  gutterBackground: '#1f1f28',
  gutterForeground: '#727169',
  lineHighlight: '#252530',
  keyword: '#957fb8',
  string: '#98bb6c',
  comment: '#727169',
  number: '#d27e99',
  function: '#7e9cd8',
  type: '#7fb4ca',
  operator: '#c0a36e',
  variable: '#dcd7ba',
  property: '#e6c384',
  link: '#7e9cd8',
  heading: '#957fb8',
}

// ---------------------------------------------------------------------------
// Light themes
// ---------------------------------------------------------------------------

const slayLight: EditorThemeColors = {
  background: '#f4f4f5',
  foreground: '#27272a',
  selection: '#d4d4d8',
  cursor: '#52525b',
  gutterBackground: '#f4f4f5',
  gutterForeground: '#a1a1aa',
  lineHighlight: '#ececee',
  keyword: '#7c3aed',
  string: '#059669',
  comment: '#a1a1aa',
  number: '#b45309',
  function: '#2563eb',
  type: '#0891b2',
  operator: '#71717a',
  variable: '#27272a',
  property: '#dc2626',
  link: '#2563eb',
  heading: '#7c3aed',
}

const slaySpecialLight: EditorThemeColors = {
  background: '#ffeecc',
  foreground: '#441100',
  selection: '#ff000030',
  cursor: '#ff0000',
  gutterBackground: '#ffeecc',
  gutterForeground: '#884400',
  lineHighlight: '#ffe8bb',
  keyword: '#ee0000',
  string: '#008800',
  comment: '#884400',
  number: '#cc6600',
  function: '#0044dd',
  type: '#cc4400',
  operator: '#ff6600',
  variable: '#441100',
  property: '#dd0088',
  link: '#0066ff',
  heading: '#ff0000',
}

const defaultLight: EditorThemeColors = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  selection: '#b4d5fe',
  cursor: '#1a1a1a',
  gutterBackground: '#ffffff',
  gutterForeground: '#9ca3af',
  lineHighlight: '#f5f5f5',
  keyword: '#9333ea',
  string: '#16a34a',
  comment: '#9ca3af',
  number: '#a16207',
  function: '#2563eb',
  type: '#0e7490',
  operator: '#6b7280',
  variable: '#1a1a1a',
  property: '#dc2626',
  link: '#2563eb',
  heading: '#9333ea',
}

const catppuccinLatte: EditorThemeColors = {
  background: '#eff1f5',
  foreground: '#4c4f69',
  selection: '#acb0be',
  cursor: '#dc8a78',
  gutterBackground: '#eff1f5',
  gutterForeground: '#8c8fa1',
  lineHighlight: '#e6e9ef',
  keyword: '#8839ef',
  string: '#40a02b',
  comment: '#8c8fa1',
  number: '#fe640b',
  function: '#1e66f5',
  type: '#df8e1d',
  operator: '#179299',
  variable: '#4c4f69',
  property: '#d20f39',
  link: '#1e66f5',
  heading: '#8839ef',
}

const solarizedLight: EditorThemeColors = {
  background: '#fdf6e3',
  foreground: '#657b83',
  selection: '#eee8d5',
  cursor: '#657b83',
  gutterBackground: '#fdf6e3',
  gutterForeground: '#93a1a1',
  lineHighlight: '#f5efdc',
  keyword: '#859900',
  string: '#2aa198',
  comment: '#93a1a1',
  number: '#d33682',
  function: '#268bd2',
  type: '#b58900',
  operator: '#657b83',
  variable: '#657b83',
  property: '#268bd2',
  link: '#268bd2',
  heading: '#cb4b16',
}

const tokyoNightLight: EditorThemeColors = {
  background: '#d5d6db',
  foreground: '#343b58',
  selection: '#9699a3',
  cursor: '#343b58',
  gutterBackground: '#d5d6db',
  gutterForeground: '#9699a3',
  lineHighlight: '#cbccd1',
  keyword: '#5a4a78',
  string: '#485e30',
  comment: '#9699a3',
  number: '#8f5e15',
  function: '#34548a',
  type: '#0f4b6e',
  operator: '#4e6087',
  variable: '#343b58',
  property: '#8c4351',
  link: '#34548a',
  heading: '#5a4a78',
}

const rosePineDawn: EditorThemeColors = {
  background: '#faf4ed',
  foreground: '#575279',
  selection: '#dfdad9',
  cursor: '#9893a5',
  gutterBackground: '#faf4ed',
  gutterForeground: '#9893a5',
  lineHighlight: '#f2ede5',
  keyword: '#286983',
  string: '#ea9d34',
  comment: '#9893a5',
  number: '#b4637a',
  function: '#56949f',
  type: '#907aa9',
  operator: '#286983',
  variable: '#575279',
  property: '#d7827e',
  link: '#56949f',
  heading: '#907aa9',
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const editorThemes: EditorThemeDefinition[] = [
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
  { id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', variant: 'light', colors: rosePineDawn },
]

export const darkEditorThemes = editorThemes.filter(t => t.variant === 'dark')
export const lightEditorThemes = editorThemes.filter(t => t.variant === 'light')

export function getEditorThemeById(id: string): EditorThemeColors {
  return editorThemes.find(t => t.id === id)?.colors ?? slay
}

export function getEditorTheme(appTheme: Theme, themeDark: string, themeLight: string): EditorThemeColors {
  const id = appTheme === 'dark' ? themeDark : themeLight
  return getEditorThemeById(id)
}
