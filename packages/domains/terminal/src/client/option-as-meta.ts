import type { Terminal as XTerm } from '@xterm/xterm'
import type { TerminalOptionAsMeta } from '@slayzone/ui'

// macOS Option key: Meta (xterm sends ESC + key — readline word nav, Claude
// Code's Option+P/T) or a composed character (Option+2 = @ on Swedish). xterm's
// `macOptionIsMeta` is one terminal-wide boolean; the `terminal_option_as_meta`
// setting is per keystroke (which Option key is held, what it typed), so the
// key handler resolves it and sets the option before xterm reads it.
// Issue #103: a hardcoded `true` made @ | \ [ ] { } ~ $ untypeable on
// Swedish/German/Nordic layouts.

/**
 * The US layout's Option layer per DOM `code`: [Option, Shift+Option], as
 * Chromium reports it in KeyboardEvent.key ('Dead' = starts a composition).
 * Measured with UCKeyTranslate — see option-as-meta.layouts.fixture.ts.
 */
export const US_OPTION_LAYER: Readonly<Record<string, readonly [string, string]>> = {
  Backquote: ['Dead', '`'],
  Backslash: ['«', '»'],
  BracketLeft: ['“', '”'],
  BracketRight: ['‘', '’'],
  Comma: ['≤', '¯'],
  Digit0: ['º', '‚'],
  Digit1: ['¡', '⁄'],
  Digit2: ['™', '€'],
  Digit3: ['£', '‹'],
  Digit4: ['¢', '›'],
  Digit5: ['∞', 'ﬁ'],
  Digit6: ['§', 'ﬂ'],
  Digit7: ['¶', '‡'],
  Digit8: ['•', '°'],
  Digit9: ['ª', '·'],
  Equal: ['≠', '±'],
  IntlBackslash: ['§', '±'],
  KeyA: ['å', 'Å'],
  KeyB: ['∫', 'ı'],
  KeyC: ['ç', 'Ç'],
  KeyD: ['∂', 'Î'],
  KeyE: ['Dead', '´'],
  KeyF: ['ƒ', 'Ï'],
  KeyG: ['©', '˝'],
  KeyH: ['˙', 'Ó'],
  KeyI: ['Dead', 'ˆ'],
  KeyJ: ['∆', 'Ô'],
  KeyK: ['˚', ''],
  KeyL: ['¬', 'Ò'],
  KeyM: ['µ', 'Â'],
  KeyN: ['Dead', '˜'],
  KeyO: ['ø', 'Ø'],
  KeyP: ['π', '∏'],
  KeyQ: ['œ', 'Œ'],
  KeyR: ['®', '‰'],
  KeyS: ['ß', 'Í'],
  KeyT: ['†', 'ˇ'],
  KeyU: ['Dead', '¨'],
  KeyV: ['√', '◊'],
  KeyW: ['∑', '„'],
  KeyX: ['≈', '˛'],
  KeyY: ['¥', 'Á'],
  KeyZ: ['Ω', '¸'],
  Minus: ['–', '—'],
  Period: ['≥', '˘'],
  Quote: ['æ', 'Æ'],
  Semicolon: ['…', 'Ú'],
  Slash: ['÷', '¿'],
  Space: [' ', ' ']
}

// The US unmodified layer, minus keys that cannot discriminate: Quote and
// Backquote are dead keys on US International (still a US layout), and
// Chromium swaps Backquote/IntlBackslash on ISO keyboards.
const US_BASE_LAYER: Readonly<Record<string, string>> = {
  ...Object.fromEntries([...'0123456789'].map((c) => [`Digit${c}`, c])),
  ...Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((c) => [`Key${c.toUpperCase()}`, c])),
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Semicolon: ';',
  Slash: '/'
}

/** `navigator.keyboard.getLayoutMap()`'s result: code → unmodified character. */
interface LayoutMapLike {
  get(code: string): string | undefined
}

/**
 * Is the active layout US-shaped (US, ABC, British, US International, EurKEY)
 * rather than Nordic/German/French/…? On a non-US layout every Option key
 * composes: its dead keys (German ~ is Option+N, a dead key like US Option+N)
 * cannot be told apart from US ones per keystroke. Keys the map lacks are
 * ignored, so an empty map (API unavailable) counts as US-like.
 */
export function isUsLikeBaseLayout(map: LayoutMapLike): boolean {
  for (const [code, char] of Object.entries(US_BASE_LAYER)) {
    const actual = map.get(code)
    if (actual !== undefined && actual !== char) return false
  }
  return true
}

/** Which Option keys are held down right now. Both false = unknown side. */
interface OptionKeysHeld {
  left: boolean
  right: boolean
}

type OptionKeystroke = Pick<KeyboardEvent, 'code' | 'key' | 'shiftKey' | 'ctrlKey' | 'metaKey'>

/** Whether this Option keystroke goes to the terminal as Meta (ESC + key). */
export function resolveOptionIsMeta(
  setting: TerminalOptionAsMeta,
  e: OptionKeystroke,
  held: OptionKeysHeld,
  usLikeBase: boolean
): boolean {
  switch (setting) {
    case 'both':
      return true
    case 'none':
      return false
    case 'left':
      return held.left
    case 'right':
      return held.right
    case 'auto': {
      // Ctrl/Cmd+Option never produces a character on macOS.
      if (e.ctrlKey || e.metaKey) return true
      if (!usLikeBase) return false
      const us = US_OPTION_LAYER[e.code]
      if (!us) return true
      // US-shaped layout: Meta where Option types exactly what it types on US
      // (∫ π † — never wanted in a terminal); compose where the layout put its
      // own character (British Option+3 = #, EurKEY Option+A = ä). Caps Lock
      // flips the case of Option letters.
      return e.key.toLowerCase() === us[e.shiftKey ? 1 : 0].toLowerCase()
    }
  }
}

// ── Live state (one per renderer) ───────────────────────────────────────────

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')
const held: OptionKeysHeld = { left: false, right: false }
// Until the layout map answers (or where the Keyboard Map API is missing —
// Safari/Firefox web shell) the per-key US comparison alone decides.
let usLikeBase = true
let layoutQueryInFlight = false
let tracking = false

/**
 * Re-read the active layout. KeyboardEvent never says which layout produced a
 * key, and Chromium fires no event on an input-source switch, so this runs at
 * startup, on window focus, and on every Option press — before the key it
 * modifies arrives.
 */
function refreshLayout(): void {
  const keyboard = (
    navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<LayoutMapLike> } }
  ).keyboard
  if (!keyboard?.getLayoutMap || layoutQueryInFlight) return
  layoutQueryInFlight = true
  keyboard
    .getLayoutMap()
    .then((map) => {
      usLikeBase = isUsLikeBaseLayout(map)
    })
    .catch(() => undefined)
    .then(() => {
      layoutQueryInFlight = false
    })
}

/**
 * Start tracking which Option key is down. KeyboardEvent.altKey does not say
 * left or right — only the Alt key's own keydown/keyup does (code AltLeft /
 * AltRight). Window-level capture, so presses while focus is elsewhere in the
 * app count. Idempotent; called at every xterm creation.
 */
export function ensureOptionKeyTracking(): void {
  if (tracking || !IS_MAC || typeof window === 'undefined') return
  tracking = true
  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'AltLeft') held.left = e.type === 'keydown'
    else if (e.code === 'AltRight') held.right = e.type === 'keydown'
    // A missed keyup (released while the window was unfocused) heals on the
    // next key event that carries no Option.
    else if (!e.altKey) held.left = held.right = false
    if (e.type === 'keydown' && (e.code === 'AltLeft' || e.code === 'AltRight')) refreshLayout()
  }
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('keyup', onKey, true)
  window.addEventListener('blur', () => {
    held.left = held.right = false
  })
  window.addEventListener('focus', refreshLayout)
  refreshLayout()
}

/**
 * Point xterm's `macOptionIsMeta` at this keystroke's answer. Call first thing
 * in the custom key handler: xterm runs that handler before every read of the
 * option (keydown, keypress, composition). Reads `setting` per call, so cached
 * and reattached terminals follow a settings change with no re-init.
 */
export function syncMacOptionIsMeta(
  terminal: XTerm | null,
  e: KeyboardEvent,
  setting: TerminalOptionAsMeta
): void {
  if (!IS_MAC || !terminal || !e.altKey) return
  const isMeta = resolveOptionIsMeta(setting, e, held, usLikeBase)
  if (terminal.options.macOptionIsMeta !== isMeta) terminal.options.macOptionIsMeta = isMeta
}
