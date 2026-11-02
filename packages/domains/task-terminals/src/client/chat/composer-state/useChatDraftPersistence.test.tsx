// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChatDraft, ChatTabState } from '@slayzone/terminal-contracts'

const server = vi.hoisted(() => ({
  hubId: 'local',
  state: null as ChatTabState | null,
  saves: [] as Array<{ tabId: string; draft: ChatDraft }>,
  fail: false,
  delays: new Map<string, Promise<void>>(),
  rev: 0
}))

vi.mock('@slayzone/transport/client', () => ({ useHubId: () => server.hubId }))

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
            if (server.fail) throw new Error('Computer offline')
            await server.delays.get(draft.text)
            server.rev += 1
            server.state = { draft: { ...draft, rev: server.rev }, scroll: null }
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
  server.hubId = 'local'
  server.saves = []
  server.rev = 0
  server.fail = false
  server.delays.clear()
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useChatDraftPersistence', () => {
  it('serializes slow saves so an older attachment edit cannot overwrite newer typing', async () => {
    let release!: () => void
    server.delays.set(
      'older',
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const h = setup({ draft: empty })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    h.rerender({ draft: { text: 'older', attachments: [] } })
    await act(() => vi.advanceTimersByTimeAsync(400))
    h.rerender({ draft: { text: 'newer', attachments: [] } })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves.map((s) => s.draft.text)).toEqual(['older'])
    await act(async () => {
      release()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(server.state?.draft.text).toBe('newer'))
    expect(localStorage.getItem(draftJournalKey('tab-1'))).toBeNull()
  })
  it('saves a return to the acknowledged draft while a different save is still in flight', async () => {
    let release!: () => void
    server.delays.set(
      'different',
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const initial = { text: 'initial', attachments: [] }
    server.state = { draft: { ...initial, rev: 1 }, scroll: null }
    server.rev = 1
    const h = setup({ draft: initial })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    h.rerender({ draft: { text: 'different', attachments: [] } })
    await act(() => vi.advanceTimersByTimeAsync(400))
    h.rerender({ draft: initial })
    await act(() => vi.advanceTimersByTimeAsync(400))
    await act(async () => {
      release()
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(server.state?.draft.text).toBe('initial'))
    expect(localStorage.getItem(draftJournalKey('tab-1'))).toBeNull()
  })
  it('isolates local journals for identical tab IDs on different hubs', async () => {
    server.hubId = 'hub-a'
    const privateDraft = { text: 'only hub a', attachments: [] }
    localStorage.setItem(
      draftJournalKey('tab-1', 'hub-a'),
      JSON.stringify({ ...privateDraft, baseRev: 0, savedAt: Date.now() })
    )
    const a = setup({ draft: empty })
    await vi.waitFor(() => expect(a.result.current.saved).toEqual(privateDraft))
    a.unmount()
    server.hubId = 'hub-b'
    const b = setup({ draft: empty })
    await vi.waitFor(() => expect(b.result.current.loaded).toBe(true))
    expect(b.result.current.saved).toBeNull()
    b.rerender({ draft: { text: 'only hub b', attachments: [] } })
    expect(JSON.parse(localStorage.getItem(draftJournalKey('tab-1', 'hub-a'))!).text).toBe(
      'only hub a'
    )
    expect(JSON.parse(localStorage.getItem(draftJournalKey('tab-1', 'hub-b'))!).text).toBe(
      'only hub b'
    )
  })

  it('keeps an unscoped legacy journal until explicitly recovered, preserving the current draft', async () => {
    const legacyKey = 'slayzone:chat-draft:tab-1'
    localStorage.setItem(
      legacyKey,
      JSON.stringify({ text: 'old unsaved text', attachments: [], baseRev: 0, savedAt: Date.now() })
    )
    const current = { text: 'current text', attachments: [] }
    server.state = { draft: { ...current, rev: 1 }, scroll: null }
    server.rev = 1
    const h = setup({ draft: current })
    await vi.waitFor(() => expect(h.result.current.legacyAvailable).toBe(true))
    expect(h.result.current.saved).toEqual(current)
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toEqual([])
    expect(localStorage.getItem(legacyKey)).not.toBeNull()
    let recovered: ChatDraft | null = null
    act(() => {
      recovered = h.result.current.recoverLegacy(current)
    })
    expect(recovered).toEqual({ text: 'current text\n\nold unsaved text', attachments: [] })
    h.rerender({ draft: recovered! })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves.at(-1)?.draft).toEqual(recovered)
    expect(localStorage.getItem(legacyKey)).toBeNull()
    expect(h.result.current.legacyAvailable).toBe(false)
  })
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

  it('saves a restored journal to the computer without saving the initial empty composer', async () => {
    server.state = { draft: { text: 'old', attachments: [], rev: 2 }, scroll: null }
    server.rev = 2
    const recovered = { text: 'unsaved edit', attachments: [] }
    localStorage.setItem(
      draftJournalKey('tab-1'),
      JSON.stringify({ ...recovered, baseRev: 2, savedAt: Date.now() })
    )
    const h = setup({ draft: empty })
    await vi.waitFor(() => expect(h.result.current.saved).toEqual(recovered))
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toEqual([])
    h.rerender({ draft: recovered })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toEqual([{ tabId: 'tab-1', draft: recovered }])
    expect(localStorage.getItem(draftJournalKey('tab-1'))).toBeNull()
  })

  it('persists an empty journal that cleared a previously saved draft', async () => {
    server.state = { draft: { text: 'old', attachments: [], rev: 2 }, scroll: null }
    server.rev = 2
    localStorage.setItem(
      draftJournalKey('tab-1'),
      JSON.stringify({ ...empty, baseRev: 2, savedAt: Date.now() })
    )
    const h = setup({ draft: empty })
    await vi.waitFor(() => expect(h.result.current.saved).toEqual(empty))
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toEqual([{ tabId: 'tab-1', draft: empty }])
  })

  it('retries a failed draft save after reconnect without requiring another edit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = setup({ draft: empty })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    server.fail = true
    const draft = { text: 'written offline', attachments: [] }
    h.rerender({ draft })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toHaveLength(1)
    expect(localStorage.getItem(draftJournalKey('tab-1'))).not.toBeNull()
    server.fail = false
    act(() => h.result.current.retry())
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toEqual([
      { tabId: 'tab-1', draft },
      { tabId: 'tab-1', draft }
    ])
    expect(localStorage.getItem(draftJournalKey('tab-1'))).toBeNull()
  })

  it('persists a new sealed version of an attachment with the same artifact id', async () => {
    const attachment = {
      artifactId: 'file',
      kind: 'text' as const,
      mediaType: 'text/plain' as const,
      name: 'note.txt',
      size: 5,
      contentHash: 'a'.repeat(64)
    }
    server.state = { draft: { text: '', attachments: [attachment], rev: 1 }, scroll: null }
    server.rev = 1
    const h = setup({ draft: { text: '', attachments: [attachment] } })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    const draft = { text: '', attachments: [{ ...attachment, contentHash: 'b'.repeat(64) }] }
    h.rerender({ draft })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toEqual([{ tabId: 'tab-1', draft }])
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
