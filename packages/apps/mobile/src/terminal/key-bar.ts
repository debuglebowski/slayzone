/**
 * The keys the phone's key bar sends to a terminal agent: what a phone keyboard
 * lacks (Esc, Ctrl, Tab, arrows, Enter) and the digits an agent's numbered questions
 * take. Each sends the bytes a terminal (xterm) sends for that key
 * (`@slayzone/terminal-contracts` key-sequences), so the program cannot tell the
 * phone from a keyboard. Esc and Ctrl+C also interrupt the agent, as on desktop.
 *
 * Ctrl is sticky (a phone cannot hold two keys): tapped, it turns the NEXT character
 * typed into Ctrl+that character (`ctrlChar`). Arrows repeat while held (`KeyRepeater`),
 * as a keyboard's do.
 */
import {
  type ArrowKey,
  arrowKey,
  ctrlKey,
  ENTER,
  ESCAPE,
  SHIFT_TAB,
  TAB
} from '@slayzone/terminal-contracts'

/** The terminal modes a key's bytes depend on (reported by the terminal view). */
export interface KeyModes {
  /** DECCKM: arrows as `ESC O A` instead of `ESC [ A`. */
  applicationCursorKeys: boolean
}

export interface BarKey {
  id: string
  label: string
  accessibilityLabel: string
  /** Desktop sends `pty.interrupt` with this key (Esc, Ctrl+C). */
  interrupts: boolean
  bytes: string | ((modes: KeyModes) => string)
  /** A modifier (Ctrl): sends nothing itself, applies to the next character typed. */
  modifier?: true
  /** Sent again and again while held. */
  repeats?: true
}

const arrow = (key: ArrowKey, label: string, name: string): BarKey => ({
  id: key,
  label,
  accessibilityLabel: `Arrow ${name}`,
  interrupts: false,
  bytes: (modes) => arrowKey(key, modes.applicationCursorKeys),
  repeats: true
})

const plain = (id: string, label: string, accessibilityLabel: string, bytes: string): BarKey => ({
  id,
  label,
  accessibilityLabel,
  interrupts: false,
  bytes
})

export const KEY_BAR: readonly BarKey[] = [
  { ...plain('esc', 'Esc', 'Escape', ESCAPE), interrupts: true },
  { ...plain('ctrl', 'Ctrl', 'Control', ''), modifier: true },
  { ...plain('ctrl-c', '^C', 'Control C', ctrlKey('c')), interrupts: true },
  plain('ctrl-d', '^D', 'Control D', ctrlKey('d')),
  plain('tab', 'Tab', 'Tab', TAB),
  plain('shift-tab', '⇧Tab', 'Shift Tab', SHIFT_TAB),
  arrow('up', '↑', 'up'),
  arrow('down', '↓', 'down'),
  arrow('left', '←', 'left'),
  arrow('right', '→', 'right'),
  plain('enter', '⏎', 'Enter', ENTER),
  plain('1', '1', 'Option 1', '1'),
  plain('2', '2', 'Option 2', '2'),
  plain('3', '3', 'Option 3', '3')
]

export function keyBytes(key: BarKey, modes: KeyModes): string {
  return typeof key.bytes === 'function' ? key.bytes(modes) : key.bytes
}

/** The C0 controls a terminal sends for Ctrl+ these (beside the letters). */
const CTRL_SYMBOLS: Readonly<Record<string, string>> = {
  ' ': '\x00',
  '@': '\x00',
  '[': '\x1b',
  '\\': '\x1c',
  ']': '\x1d',
  '^': '\x1e',
  _: '\x1f',
  '?': '\x7f'
}

/** What a terminal sends for Ctrl+`char`; null when Ctrl does nothing to it. */
export function ctrlChar(char: string): string | null {
  if (/^[a-zA-Z]$/.test(char)) return ctrlKey(char)
  return CTRL_SYMBOLS[char] ?? null
}

/** A held key: sent at once, then — after a pause — again and again until released. */
export class KeyRepeater {
  /** Before the first repeat (iOS's own key repeat waits about as long). */
  static readonly DELAY_MS = 400
  static readonly INTERVAL_MS = 80
  private timer: ReturnType<typeof setTimeout> | null = null

  press(send: () => void): void {
    this.release()
    send()
    const repeat = (): void => {
      send()
      this.timer = setTimeout(repeat, KeyRepeater.INTERVAL_MS)
    }
    this.timer = setTimeout(repeat, KeyRepeater.DELAY_MS)
  }

  release(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
