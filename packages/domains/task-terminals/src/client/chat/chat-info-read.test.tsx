// @vitest-environment jsdom
// Pins the shared `chat.getInfo` read: the setting pills of one chat panel hydrate
// with ONE request per commit (restore of ~36 chats used to send ~2,100 reads),
// and a later read never joins an earlier one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

const m = vi.hoisted(() => {
  const getInfo = vi.fn<(input: { tabId: string; mode?: string }) => Promise<unknown>>()
  const cached = () => vi.fn<() => Promise<unknown>>().mockResolvedValue(null)
  return {
    getInfo,
    client: {
      chat: {
        getInfo: { query: getInfo },
        getMode: { query: cached() },
        getModel: { query: cached() },
        getEffort: { query: cached() },
        getCollaboration: { query: cached() },
        getFastMode: { query: cached() },
        getAutoEligibility: {
          query: vi.fn().mockResolvedValue({ eligible: false, optedIn: false })
        }
      }
    }
  }
})

vi.mock('../trpc', () => ({ useTRPCClient: () => m.client }))
vi.mock('@slayzone/ui', async () => ({
  ...(await vi.importActual<object>('../../../../../shared/ui/src/use-stable-callback')),
  toast: vi.fn()
}))

import { readChatInfo } from './chat-info-read'
import { useChatMode } from './useChatMode'
import { useChatModel } from './useChatModel'
import { useChatEffort } from './useChatEffort'
import { useChatCollaboration } from './useChatCollaboration'
import { useChatFastMode } from './useChatFastMode'

type Client = Parameters<typeof readChatInfo>[0]
const client = m.client as unknown as Client

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })

beforeEach(() => {
  m.getInfo.mockReset().mockResolvedValue(null)
})
afterEach(cleanup)

describe('readChatInfo', () => {
  it('callers in the same turn share one request', async () => {
    const reads = [1, 2, 3, 4, 5].map(() => readChatInfo(client, 'tab1', 'claude-chat', 0))
    expect(m.getInfo).toHaveBeenCalledTimes(1)
    expect(new Set(reads).size).toBe(1)
    await Promise.all(reads)
  })

  it('a later turn sends its own request, even while the first is still in flight', async () => {
    m.getInfo.mockReturnValue(new Promise(() => {}))
    void readChatInfo(client, 'tab1', 'claude-chat', 0)
    await Promise.resolve()
    void readChatInfo(client, 'tab1', 'claude-chat', 0)
    expect(m.getInfo).toHaveBeenCalledTimes(2)
  })

  it('a newer settings generation never joins an older read', () => {
    void readChatInfo(client, 'tab1', 'claude-chat', 0)
    void readChatInfo(client, 'tab1', 'claude-chat', 1)
    expect(m.getInfo).toHaveBeenCalledTimes(2)
  })

  it('different tabs or modes are separate reads', () => {
    void readChatInfo(client, 'tab1', 'claude-chat', 0)
    void readChatInfo(client, 'tab2', 'claude-chat', 0)
    void readChatInfo(client, 'tab1', 'codex-chat', 0)
    expect(m.getInfo).toHaveBeenCalledTimes(3)
  })
})

function usePills(settingsGeneration: number) {
  const ids = {
    taskId: 'task1',
    mode: 'claude-chat',
    tabId: 'tab1',
    cwd: '/repo',
    settingsGeneration
  }
  return [
    useChatMode(ids),
    useChatModel(ids),
    useChatEffort(ids),
    useChatCollaboration(ids),
    useChatFastMode(ids)
  ]
}

describe('a chat panel’s five setting pills', () => {
  it('hydrate with one getInfo on mount', async () => {
    renderHook(() => usePills(0))
    await flush()
    expect(m.getInfo).toHaveBeenCalledTimes(1)
  })

  it('re-read with one more getInfo when the task’s saved settings change', async () => {
    const { rerender } = renderHook(({ gen }) => usePills(gen), { initialProps: { gen: 0 } })
    await flush()
    rerender({ gen: 1 })
    await flush()
    expect(m.getInfo).toHaveBeenCalledTimes(2)
  })
})
