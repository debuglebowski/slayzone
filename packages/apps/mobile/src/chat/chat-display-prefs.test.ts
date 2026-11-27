import { DEFAULT_CHAT_ACTIVITY_SETTINGS } from '@slayzone/terminal/chat-activity'
import { createChatDisplayPrefs } from './chat-display-prefs'

function memory(initial: string | null = null) {
  let text = initial
  return {
    read: () => text,
    write: (next: string) => {
      text = next
    }
  }
}

describe('chat display prefs', () => {
  it("starts from desktop's defaults, and keeps what the user changed", () => {
    const store = memory()
    const prefs = createChatDisplayPrefs(store)
    expect(prefs.get()).toEqual(DEFAULT_CHAT_ACTIVITY_SETTINGS)
    const heard = jest.fn()
    prefs.subscribe(heard)
    prefs.set({ ...prefs.get(), showActivityTools: false })
    expect(heard).toHaveBeenCalledTimes(1)
    expect(createChatDisplayPrefs(store).get().showActivityTools).toBe(false)
  })

  it('unreadable content is the defaults; a foreign value keeps its default', () => {
    expect(createChatDisplayPrefs(memory('{oops')).get()).toEqual(DEFAULT_CHAT_ACTIVITY_SETTINGS)
    expect(
      createChatDisplayPrefs(memory('{"showThinking":"no","showActivities":false}')).get()
    ).toEqual({ ...DEFAULT_CHAT_ACTIVITY_SETTINGS, showActivities: false })
  })

  it('a storage that fails keeps the change for this launch', () => {
    const prefs = createChatDisplayPrefs({
      read: () => {
        throw new Error('no disk')
      },
      write: () => {
        throw new Error('no disk')
      }
    })
    prefs.set({ ...prefs.get(), showThinking: false })
    expect(prefs.get().showThinking).toBe(false)
  })
})
