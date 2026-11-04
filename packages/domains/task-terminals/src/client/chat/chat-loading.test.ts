import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatsLoadingCount, subscribeChatsLoading, trackChatLoading } from './chat-loading'

const releases: Array<() => void> = []
const track = (): (() => void) => {
  const release = trackChatLoading()
  releases.push(release)
  return release
}
afterEach(() => {
  for (const release of releases.splice(0)) release()
})

describe('chats loading', () => {
  it('counts each tracked chat until it is released', () => {
    expect(chatsLoadingCount()).toBe(0)
    const a = track()
    track()
    expect(chatsLoadingCount()).toBe(2)
    a()
    expect(chatsLoadingCount()).toBe(1)
  })

  it('a release is idempotent: a second call never drops another chat', () => {
    const a = track()
    track()
    a()
    a()
    expect(chatsLoadingCount()).toBe(1)
  })

  it('notifies subscribers on each change, and not after unsubscribing', () => {
    const cb = vi.fn()
    const off = subscribeChatsLoading(cb)
    const a = track()
    a()
    a()
    expect(cb).toHaveBeenCalledTimes(2)
    off()
    track()
    expect(cb).toHaveBeenCalledTimes(2)
  })
})
