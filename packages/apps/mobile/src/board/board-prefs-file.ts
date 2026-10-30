/**
 * Where the board's preferences live: a file in the app's documents directory
 * (expo-file-system). Not the cache directory: the OS may purge that, and a remembered
 * project and view are the user's choice, not regenerable data. Not secret, so not the
 * keychain. Synchronous calls: saves land in the order they were made.
 */
import { File, Paths } from 'expo-file-system'
import { createBoardPrefs } from './board-prefs'

const prefsFile = (): File => new File(Paths.document, 'board-prefs.json')

export const boardPrefsFile = createBoardPrefs({
  read: () => {
    const file = prefsFile()
    return file.exists ? file.textSync() : null
  },
  write: (text) => prefsFile().writeSync(text)
})
