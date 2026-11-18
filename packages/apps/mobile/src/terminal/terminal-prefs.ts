/**
 * What the phone's terminal remembers on this device: the text size the user picked
 * (`terminal-scale.ts`: readable, the default, or every column fitted to the screen).
 * One JSON file; unreadable or foreign content = nothing kept. The file itself is
 * `terminal-prefs-file.ts`.
 */
import type { PrefsStorage } from '../board/board-prefs'
import { TEXT_SIZES, type TextSize } from './terminal-scale'

export interface TerminalPrefs {
  textSize: TextSize
}

export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = { textSize: 'readable' }

export interface TerminalPrefsStore {
  load: () => TerminalPrefs
  save: (prefs: TerminalPrefs) => void
}

export function createTerminalPrefs(storage: PrefsStorage): TerminalPrefsStore {
  return {
    load: () => {
      try {
        const text = storage.read()
        return text ? parse(JSON.parse(text)) : DEFAULT_TERMINAL_PREFS
      } catch {
        return DEFAULT_TERMINAL_PREFS
      }
    },
    save: (prefs) => {
      try {
        storage.write(JSON.stringify(prefs))
      } catch {
        // Not kept: the next launch starts readable, nothing else is lost.
      }
    }
  }
}

function parse(raw: unknown): TerminalPrefs {
  const textSize = (raw as { textSize?: unknown } | null)?.textSize
  return TEXT_SIZES.includes(textSize as TextSize)
    ? { textSize: textSize as TextSize }
    : DEFAULT_TERMINAL_PREFS
}
