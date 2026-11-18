/**
 * Where the terminal's preferences live: a file in the app's documents directory
 * (expo-file-system), as the board's (`board-prefs-file.ts`): the user's choice, not
 * regenerable data, and not secret. Synchronous calls: saves land in the order made.
 */
import { File, Paths } from 'expo-file-system'
import { createTerminalPrefs } from './terminal-prefs'

const prefsFile = (): File => new File(Paths.document, 'terminal-prefs.json')

export const terminalPrefsFile = createTerminalPrefs({
  read: () => {
    const file = prefsFile()
    return file.exists ? file.textSync() : null
  },
  write: (text) => prefsFile().writeSync(text)
})
