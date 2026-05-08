import { detectPlatform, type Platform } from './platform'

const DISPLAY_MAP_MAC: Record<string, string> = {
  mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃',
  period: '.', comma: ',', slash: '/', backslash: '\\',
}
const DISPLAY_MAP_OTHER: Record<string, string> = {
  mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl',
  period: '.', comma: ',', slash: '/', backslash: '\\',
}

/** Punctuation key names react-hotkeys-hook expects (matches e.code lowercased).
 *  Maps the literal char → key name used in shortcut strings. */
const PUNCT_TO_NAME: Record<string, string> = {
  '.': 'period', ',': 'comma', '/': 'slash', '\\': 'backslash',
}
/** Reverse: name → literal char, for raw keydown matching against e.key. */
const NAME_TO_PUNCT: Record<string, string> = Object.fromEntries(
  Object.entries(PUNCT_TO_NAME).map(([k, v]) => [v, k])
)

/** Normalize punctuation chars in a hotkey string to the names react-hotkeys-hook expects.
 *  Used by code that records new bindings; safe to apply repeatedly. */
export function normalizeHotkeyString(keys: string): string {
  return keys.split('+').map(part => PUNCT_TO_NAME[part] ?? part).join('+')
}

export function formatKeysForDisplay(keys: string | null, platform?: Platform): string | null {
  if (keys === null) return null
  const map = (platform ?? detectPlatform()) === 'mac' ? DISPLAY_MAP_MAC : DISPLAY_MAP_OTHER
  return keys.split('+').map(part => {
    const mapped = map[part]
    if (mapped) return mapped
    return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
  }).join('')
}

/**
 * Compose a UI label with an optional shortcut hint in parentheses.
 * Returns the bare label when keys is null — safe replacement for template interpolation.
 */
export function withShortcut(label: string, keys: string | null): string {
  return keys ? `${label} (${keys})` : label
}

const VERBOSE_MAP_MAC: Record<string, string> = {
  mod: 'Cmd', shift: 'Shift', alt: 'Opt', ctrl: 'Ctrl',
  period: '.', comma: ',', slash: '/', backslash: '\\',
}
const VERBOSE_MAP_OTHER: Record<string, string> = {
  mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl',
  period: '.', comma: ',', slash: '/', backslash: '\\',
}

/** Verbose display: spelled-out modifiers joined with `+` (e.g. "Ctrl+.", "Cmd+Shift+."). */
export function formatKeysVerbose(keys: string | null, platform?: Platform): string | null {
  if (keys === null) return null
  const map = (platform ?? detectPlatform()) === 'mac' ? VERBOSE_MAP_MAC : VERBOSE_MAP_OTHER
  return keys.split('+').map(part => {
    const mapped = map[part]
    if (mapped) return mapped
    return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
  }).join('+')
}

export function toElectronAccelerator(keys: string | null): string | null {
  if (keys === null) return null
  return keys.split('+').map(part => {
    if (part === 'mod') return 'CmdOrCtrl'
    if (part === 'shift') return 'Shift'
    if (part === 'alt') return 'Alt'
    if (part === 'ctrl') return 'Ctrl'
    const punct = NAME_TO_PUNCT[part]
    if (punct) return punct
    return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
  }).join('+')
}

/**
 * Check if a KeyboardEvent matches a shortcut string like "mod+g" or "mod+shift+g".
 * Used by raw keydown handlers that can't use react-hotkeys-hook.
 * Returns false when keys is null (unbound shortcut).
 */
export function matchesShortcut(e: KeyboardEvent, keys: string | null): boolean {
  if (keys === null) return false
  const parts = keys.split('+')
  const key = parts[parts.length - 1]
  const wantMod = parts.includes('mod')
  const wantShift = parts.includes('shift')
  const wantAlt = parts.includes('alt')
  const wantCtrl = parts.includes('ctrl')

  const isMac = detectPlatform() === 'mac'

  if (isMac) {
    if (wantMod !== e.metaKey) return false
    if (wantCtrl !== e.ctrlKey) return false
  } else {
    if ((wantMod || wantCtrl) !== e.ctrlKey) return false
    if (e.metaKey) return false
  }
  if (wantShift !== e.shiftKey) return false
  if (wantAlt !== e.altKey) return false

  // On macOS, Alt produces special characters (e.g. Alt+R → ®), so e.key won't
  // match the shortcut letter. Fall back to e.code (e.g. "KeyR" → "r") when Alt is held.
  if (wantAlt && isMac && e.code && key.length === 1) {
    return e.code.replace(/^Key/, '').toLowerCase() === key
  }
  const expectedKey = NAME_TO_PUNCT[key] ?? key
  return e.key.toLowerCase() === expectedKey
}

/** Electron's before-input-event Input shape (subset we need). */
export interface ElectronInput {
  type: string
  key: string
  code?: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
}

/**
 * Check if an Electron before-input-event Input matches a shortcut string.
 * Same logic as matchesShortcut but for Electron's Input type.
 */
export function matchesElectronInput(input: ElectronInput, keys: string | null): boolean {
  if (keys === null) return false
  if (input.type !== 'keyDown') return false

  const parts = keys.split('+')
  const key = parts[parts.length - 1]
  const wantMod = parts.includes('mod')
  const wantShift = parts.includes('shift')
  const wantAlt = parts.includes('alt')
  const wantCtrl = parts.includes('ctrl')

  const isMac = detectPlatform() === 'mac'

  if (isMac) {
    if (wantMod !== input.meta) return false
    if (wantCtrl !== input.control) return false
  } else {
    if ((wantMod || wantCtrl) !== input.control) return false
    if (input.meta) return false
  }
  if (wantShift !== input.shift) return false
  if (wantAlt !== input.alt) return false

  // On macOS, Alt produces special characters (e.g. Alt+R → ®). Fall back to code.
  if (wantAlt && isMac && input.code && key.length === 1) {
    return input.code.replace(/^Key/, '').toLowerCase() === key
  }
  const expectedKey = NAME_TO_PUNCT[key] ?? key
  return input.key.toLowerCase() === expectedKey
}
