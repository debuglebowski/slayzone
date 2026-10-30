/**
 * The keys the phone's key bar sends to a terminal agent: what a phone keyboard
 * lacks (Esc, Ctrl, Tab, arrows, Enter) and the digits an agent's numbered questions
 * take. Each sends the bytes a terminal (xterm) sends for that key
 * (`@slayzone/terminal-contracts` key-sequences), so the program cannot tell the
 * phone from a keyboard. Esc and Ctrl+C also interrupt the agent, as on desktop.
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
}

const arrow = (key: ArrowKey, label: string, name: string): BarKey => ({
  id: key,
  label,
  accessibilityLabel: `Arrow ${name}`,
  interrupts: false,
  bytes: (modes) => arrowKey(key, modes.applicationCursorKeys)
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
