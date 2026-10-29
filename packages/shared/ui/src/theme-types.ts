/** Chrome CSS variables — matches the vars in main.css */
export interface ChromeColors {
  background: string
  foreground: string
  card: string
  cardForeground: string
  popover: string
  popoverForeground: string
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  muted: string
  mutedForeground: string
  accent: string
  accentForeground: string
  destructive: string
  border: string
  input: string
  ring: string
  chart1: string
  chart2: string
  chart3: string
  chart4: string
  chart5: string
  sidebar: string
  sidebarForeground: string
  sidebarPrimary: string
  sidebarPrimaryForeground: string
  sidebarAccent: string
  sidebarAccentForeground: string
  sidebarBorder: string
  sidebarRing: string
  surface0: string
  surface1: string
  surface2: string
  surface3: string
  modal: string
  modalBorder: string
  /**
   * Status tones. Each tone T has four roles:
   * - `T` — the tone: icons, status dots, solid fills, base for borders/tints (`border-T/40`, `bg-T/10`)
   * - `TForeground` — tone-coloured text, readable on surfaces and on the tone's own tints
   * - `TEmphasis` — deeper partner: gradient end stops (`from-T to-T-emphasis`), hover on solid
   * - `TContrast` — icon/text drawn on a solid `bg-T` or the `T → T-emphasis` gradient
   */
  success: string
  successForeground: string
  successEmphasis: string
  successContrast: string
  /** Attention / caution: retries, interruptions, denied tools, awaiting approval. */
  warning: string
  warningForeground: string
  warningEmphasis: string
  warningContrast: string
  /** Informational / input wanted (e.g. a question for the user). */
  info: string
  infoForeground: string
  infoEmphasis: string
  infoContrast: string
  /** The AI agent's identity colour (avatars, agent activity), provider-neutral. */
  agent: string
  agentForeground: string
  agentEmphasis: string
  agentContrast: string
  /** Diff lines: tone for line tints, gutters and word highlights; foreground for line text. */
  diffAdded: string
  diffAddedForeground: string
  diffRemoved: string
  diffRemovedForeground: string
}

/** Structural mirror of xterm.js ITheme — no @xterm/xterm dependency */
export interface TerminalThemeColors {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  selectionForeground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/** Editor chrome + syntax token colors */
export interface EditorThemeColors {
  background: string
  foreground: string
  selection: string
  cursor: string
  gutterBackground: string
  gutterForeground: string
  lineHighlight: string
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

/** A single variant (dark or light) of a unified theme */
export interface UnifiedThemeVariant {
  chrome: ChromeColors
  terminal: TerminalThemeColors
  editor: EditorThemeColors
}

/** A complete unified theme with dark and/or light variants */
export interface UnifiedThemeDefinition {
  id: string
  name: string
  dark?: UnifiedThemeVariant
  light?: UnifiedThemeVariant
}

/** Resolved app theme. Owned here so `useTheme` consumers need not depend on settings. */
export type Theme = 'light' | 'dark'
/** The user's choice; `system` follows the OS. */
export type ThemePreference = 'light' | 'dark' | 'system'
