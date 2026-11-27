/**
 * What the phone's chats show of a turn's work, kept on this device (a phone often
 * wants less than the desktop shows): the shared activity settings
 * (`@slayzone/terminal/chat-activity`, desktop's Chat display options). One JSON file;
 * unreadable or foreign content = the defaults. Every chat on screen follows a change
 * at once (`subscribe`). The file itself is `chat-display-prefs-file.ts`.
 */
import {
  type ChatActivitySettings,
  DEFAULT_CHAT_ACTIVITY_SETTINGS
} from '@slayzone/terminal/chat-activity'
import type { PrefsStorage } from '../board/board-prefs'

export interface ChatDisplayPrefsStore {
  get: () => ChatActivitySettings
  set: (next: ChatActivitySettings) => void
  subscribe: (listener: () => void) => () => void
}

const KEYS = Object.keys(DEFAULT_CHAT_ACTIVITY_SETTINGS) as Array<keyof ChatActivitySettings>

export function createChatDisplayPrefs(storage: PrefsStorage): ChatDisplayPrefsStore {
  let current: ChatActivitySettings | null = null
  const listeners = new Set<() => void>()
  const load = (): ChatActivitySettings => {
    try {
      const text = storage.read()
      return text ? parse(JSON.parse(text)) : DEFAULT_CHAT_ACTIVITY_SETTINGS
    } catch {
      return DEFAULT_CHAT_ACTIVITY_SETTINGS
    }
  }
  return {
    get: () => {
      current ??= load()
      return current
    },
    set: (next) => {
      current = next
      try {
        storage.write(JSON.stringify(next))
      } catch {
        // Not kept: this launch still shows it, the next starts from the defaults.
      }
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/** Each known setting that is a boolean; anything else keeps its default. */
function parse(raw: unknown): ChatActivitySettings {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const out = { ...DEFAULT_CHAT_ACTIVITY_SETTINGS }
  for (const key of KEYS) {
    const value = obj[key]
    if (typeof value === 'boolean') out[key] = value
  }
  return out
}
