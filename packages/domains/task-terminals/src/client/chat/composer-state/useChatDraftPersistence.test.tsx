// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChatDraft, ChatTabState } from '@slayzone/terminal-contracts'

const server = vi.hoisted(() => ({
  state: null as ChatTabState | null,
  saves: [] as Array<{ tabId: string; draft: ChatDraft }>,
  rev: 0
}))

vi.mock('../../trpc', () => ({
  useTRPC: () => ({
    chat: {
      tabState: {
        get: {
          queryOptions: (input: { tabId: string }, opts?: { enabled?: boolean }) => ({
            queryKey: ['tabState', input.tabId],
            queryFn: async () => server.state,
            enabled: opts?.enabled ?? true
          })
        }
      }
    }
  }),
  useTRPCClient: () => ({
    chat: {
      tabState: {
        saveDraft: {
          mutate: async ({ tabId, draft }: { tabId: string; draft: ChatDraft }) => {
            server.saves.push({ tabId, draft })
            server.rev += 1
            return { rev: server.rev }
          }
        }
      }
    }
  })
}))

import { draftJournalKey, useChatDraftPersistence } from './useChatDraftPersistence'

const empty: ChatDraft = { text: '', attachments: [] }

function setup(initial: { draft: ChatDraft; enabled?: boolean; paused?: boolean }) {
  const client = new QueryClient()
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(
    (p: { draft: ChatDraft; enabled?: boolean; paused?: boolean }) =>
      useChatDraftPersistence({
        tabId: 'tab-1',
        enabled: p.enabled ?? true,
        text: p.draft.text,
        attachments: p.draft.attachments,
        paused: p.paused ?? false
      }),
    { wrapper, initialProps: initial }
  )
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  server.state = null
  server.saves = []
  server.rev = 0
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useChatDraftPersistence', () => {
  it('loads the saved draft once (what the composer restores)', async () => {
    server.state = { draft: { text: 'half a thought', attachments: [], rev: 4 }, scroll: null }
    server.rev = 4
    const h = setup({ draft: empty })
    await vi.waitFor(() =>
      expect(h.result.current.saved).toEqual({ text: 'half a thought', attachments: [] })
    )
    expect(h.result.current.loaded).toBe(true)
  })

  it('never reports loaded before the saved draft is there (the composer restores on loaded)', async () => {
    server.state = { draft: { text: 'saved text', attachments: [], rev: 1 }, scroll: null }
    const seen: Array<{ loaded: boolean; saved: unknown }> = []
    const client = new QueryClient()
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    renderHook(
      () => {
        const r = useChatDraftPersistence({
          tabId: 'tab-1',
          enabled: true,
          text: '',
          attachments: [],
          paused: false
        })
        seen.push({ loaded: r.loaded, saved: r.saved })
        return r
      },
      { wrapper }
    )
    await vi.waitFor(() =>
      expect(seen.at(-1)?.saved).toEqual({ text: 'saved text', attachments: [] })
    )
    expect(seen.filter((r) => r.loaded && r.saved === null)).toEqual([])
  })

  it('nothing saved: loaded, saved = null', async () => {
    const h = setup({ draft: empty })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    expect(h.result.current.saved).toBeNull()
  })

  it('saves a change after a short pause (debounced), journal first', async () => {
    const h = setup({ draft: empty })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    h.rerender({ draft: { text: 'h', attachments: [] } })
    h.rerender({ draft: { text: 'hello', attachments: [] } })
    expect(JSON.parse(localStorage.getItem(draftJournalKey('tab-1'))!)).toMatchObject({
      text: 'hello',
      baseRev: 0
    })
    expect(server.saves).toEqual([])
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toEqual([{ tabId: 'tab-1', draft: { text: 'hello', attachments: [] } }])
    // Acked: the journal entry is gone.
    await vi.waitFor(() => expect(localStorage.getItem(draftJournalKey('tab-1'))).toBeNull())
  })

  it('an unmount flushes the pending save at once', async () => {
    const h = setup({ draft: empty })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    h.rerender({ draft: { text: 'leaving', attachments: [] } })
    h.unmount()
    await vi.waitFor(() => expect(server.saves.map((s) => s.draft.text)).toEqual(['leaving']))
  })

  it('a journal newer than the saved draft (reload before the save landed) wins', async () => {
    server.state = { draft: { text: 'old', attachments: [], rev: 2 }, scroll: null }
    server.rev = 2
    localStorage.setItem(
      draftJournalKey('tab-1'),
      JSON.stringify({
        text: 'typed just before the reload',
        attachments: [],
        baseRev: 2,
        savedAt: Date.now()
      })
    )
    const h = setup({ draft: empty })
    await vi.waitFor(() =>
      expect(h.result.current.saved).toEqual({
        text: 'typed just before the reload',
        attachments: []
      })
    )
  })

  it('a journal based on an older revision (another window saved since) loses', async () => {
    server.state = {
      draft: { text: 'from the other window', attachments: [], rev: 5 },
      scroll: null
    }
    localStorage.setItem(
      draftJournalKey('tab-1'),
      JSON.stringify({ text: 'stale', attachments: [], baseRev: 3, savedAt: Date.now() })
    )
    const h = setup({ draft: empty })
    await vi.waitFor(() =>
      expect(h.result.current.saved).toEqual({ text: 'from the other window', attachments: [] })
    )
    expect(localStorage.getItem(draftJournalKey('tab-1'))).toBeNull()
  })

  it('paused (browsing prompt history): nothing is saved', async () => {
    const h = setup({ draft: empty })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    h.rerender({ draft: { text: 'recalled prompt', attachments: [] }, paused: true })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(server.saves).toEqual([])
  })

  it('disabled (Codex): no load, no save', async () => {
    const h = setup({ draft: empty, enabled: false })
    h.rerender({ draft: { text: 'x', attachments: [] }, enabled: false })
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(h.result.current.saved).toBeNull()
    expect(server.saves).toEqual([])
  })
})
