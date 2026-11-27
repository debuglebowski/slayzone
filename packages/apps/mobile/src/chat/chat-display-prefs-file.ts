/**
 * Where the chat display settings live: a file in the app's documents directory
 * (expo-file-system), as the terminal's (`terminal-prefs-file.ts`): the user's choice,
 * not regenerable data, and not secret. `useChatDisplayPrefs`: the settings, and a
 * change, for every chat on screen.
 */
import type { ChatActivitySettings } from '@slayzone/terminal/chat-activity'
import { File, Paths } from 'expo-file-system'
import { useCallback, useSyncExternalStore } from 'react'
import { createChatDisplayPrefs } from './chat-display-prefs'

const prefsFile = (): File => new File(Paths.document, 'chat-display-prefs.json')

export const chatDisplayPrefsFile = createChatDisplayPrefs({
  read: () => {
    const file = prefsFile()
    return file.exists ? file.textSync() : null
  },
  write: (text) => prefsFile().writeSync(text)
})

export function useChatDisplayPrefs(): [
  ChatActivitySettings,
  (change: Partial<ChatActivitySettings>) => void
] {
  const settings = useSyncExternalStore(
    chatDisplayPrefsFile.subscribe,
    chatDisplayPrefsFile.get,
    chatDisplayPrefsFile.get
  )
  const change = useCallback((next: Partial<ChatActivitySettings>) => {
    chatDisplayPrefsFile.set({ ...chatDisplayPrefsFile.get(), ...next })
  }, [])
  return [settings, change]
}
