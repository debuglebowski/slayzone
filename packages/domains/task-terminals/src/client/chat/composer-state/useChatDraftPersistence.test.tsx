// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChatDraft, ChatTabState } from '@slayzone/terminal-contracts'

const server = vi.hoisted(() => ({
  hubId: 'local',
  state: null as ChatTabState | null,
  saves: [] as Array<{
    tabId: string
    draft: ChatDraft
    expectedMode?: string
    expectedOwnership?: { id: string; epoch: number }
  }>,
  fail: false,
  load: null as Promise<ChatTabState | null> | null,
  delays: new Map<string, Promise<void>>(),
  /** Committed on the computer, but the reply is late (slow relay / busy computer). */
  ackDelays: new Map<string, Promise<void>>(),
  rev: 0
}))

vi.mock('@slayzone/transport/client', () => ({ useHubId: () => server.hubId }))

vi.mock('../../trpc', () => ({
  useTRPC: () => ({
    chat: {
      tabState: {
        get: {
          queryOptions: (
            input: { tabId: string; expectedMode?: string },
            opts?: { enabled?: boolean }
          ) => ({
            queryKey: [
              'tabState',
              input.tabId,
              ...(input.expectedMode ? [input.expectedMode] : [])
            ],
            queryFn: async () => (server.load ? server.load : server.state),
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
          mutate: async (input: {
            tabId: string
            draft: ChatDraft
            expectedMode?: string
            expectedOwnership?: { id: string; epoch: number }
          }) => {
            const { draft } = input
            const acceptedRev = (server.state?.draft.rev ?? server.rev) + 1
            server.saves.push(input)
            if (server.fail) throw new Error('Computer offline')
            await server.delays.get(draft.text)
            if (
              input.expectedOwnership &&
              server.state?.ownership &&
              (input.expectedOwnership.id !== server.state.ownership.id ||
                input.expectedOwnership.epoch !== server.state.ownership.epoch)
            )
              return { rev: acceptedRev } // A delayed ACK belongs to its captured old store.
            server.rev += 1
            server.state = {
              ...server.state,
              draft: { ...draft, rev: server.rev },
              scroll: server.state?.scroll ?? null
            }
            const rev = server.rev
            await server.ackDelays.get(draft.text)
            return { rev }
          }
        }
      }
    }
  })
}))

import { draftJournalKey, useChatDraftPersistence } from './useChatDraftPersistence'

const empty: ChatDraft = { text: '', attachments: [] }

function setup(
  initial: { draft: ChatDraft; enabled?: boolean; paused?: boolean; mode?: string },
  client = new QueryClient()
) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(
    (p: { draft: ChatDraft; enabled?: boolean; paused?: boolean; mode?: string }) =>
      useChatDraftPersistence({
        tabId: 'tab-1',
        mode: p.mode,
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
  server.load = null
  server.delays.clear()
  server.ackDelays.clear()
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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

  it('a newer server draft stays authoritative while a stale local journal remains recoverable', async () => {
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
    expect(JSON.parse(localStorage.getItem(draftJournalKey('tab-1'))!).text).toBe('stale')
    expect(h.result.current.conflictAvailable).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toEqual([])
  })

  it('journals early edits with unknown revision and combines a conflicting saved draft only explicitly', async () => {
    const remoteFile = {
      artifactId: 'remote',
      name: 'remote.txt',
      kind: 'text' as const,
      mediaType: 'text/plain' as const,
      size: 1
    }
    const localFile = { ...remoteFile, artifactId: 'local', name: 'local.txt' }
    let finish!: (state: ChatTabState | null) => void
    server.load = new Promise((resolve) => {
      finish = resolve
    })
    const h = setup({ draft: empty })
    const local = { text: 'typed before remote load', attachments: [localFile] }
    h.rerender({ draft: local })
    expect(JSON.parse(localStorage.getItem(draftJournalKey('tab-1'))!)).toMatchObject({
      ...local,
      baseRev: null
    })
    const remote = {
      draft: { text: 'saved on another device', attachments: [remoteFile], rev: 7 },
      scroll: null
    }
    server.state = remote
    server.rev = 7
    await act(async () => {
      finish(remote)
    })
    await vi.waitFor(() => expect(h.result.current.conflictAvailable).toBe(true))
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toEqual([])
    expect(server.state?.draft.text).toBe('saved on another device')
    let recovered!: ChatDraft | null
    act(() => {
      recovered = h.result.current.recoverConflict(local)
    })
    expect(recovered).toEqual({
      text: 'typed before remote load\n\nsaved on another device',
      attachments: [localFile, remoteFile]
    })
    h.rerender({ draft: recovered! })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves.at(-1)?.draft).toEqual(recovered)
    expect(h.result.current.conflictAvailable).toBe(false)
  })

  it('dismissing a conflict keeps only the current draft, drops the other copy and resumes saving', async () => {
    const key = draftJournalKey('tab-1')
    localStorage.setItem(
      key,
      JSON.stringify({ text: 'offline edit', attachments: [], baseRev: null, savedAt: Date.now() })
    )
    server.state = { draft: { text: 'other device', attachments: [], rev: 4 }, scroll: null }
    server.rev = 4
    const h = setup({ draft: empty })
    await vi.waitFor(() => expect(h.result.current.conflictAvailable).toBe(true))
    const current = { text: 'what I see', attachments: [] }
    h.rerender({ draft: current })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toEqual([])
    let dismissed!: boolean
    act(() => {
      dismissed = h.result.current.dismissConflict(current)
    })
    expect(dismissed).toBe(true)
    expect(h.result.current.conflictAvailable).toBe(false)
    expect(localStorage.getItem(`${key}:conflicts`)).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves.at(-1)?.draft).toEqual(current)
    expect(server.state?.draft.text).toBe('what I see')
    h.rerender({ draft: { text: 'what I see, edited', attachments: [] } })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.state?.draft.text).toBe('what I see, edited')
  })

  it('an unresolved journal restores while offline; later remote recovery preserves newer typing', async () => {
    localStorage.setItem(
      draftJournalKey('tab-1'),
      JSON.stringify({ text: 'offline edit', attachments: [], baseRev: null, savedAt: Date.now() })
    )
    let finish!: (state: ChatTabState | null) => void
    server.load = new Promise((resolve) => {
      finish = resolve
    })
    const h = setup({ draft: empty })
    expect(h.result.current.loaded).toBe(true)
    expect(h.result.current.saved).toEqual({ text: 'offline edit', attachments: [] })
    h.rerender({ draft: { text: 'newer local edit', attachments: [] } })
    const remote = { draft: { text: 'other device', attachments: [], rev: 4 }, scroll: null }
    await act(async () => {
      finish(remote)
    })
    await vi.waitFor(() => expect(h.result.current.conflictAvailable).toBe(true))
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toEqual([])
    expect(JSON.parse(localStorage.getItem(draftJournalKey('tab-1'))!).text).toBe(
      'newer local edit'
    )
    h.unmount()
    expect(localStorage.getItem(`${draftJournalKey('tab-1')}:conflicts`)).toContain('other device')
  })

  it('failed conflict preservation cannot replace the only durable local copy with a shorter restored draft', async () => {
    const key = draftJournalKey('tab-1')
    const local = { text: 'long local copy that must survive a quota error', attachments: [] }
    localStorage.setItem(key, JSON.stringify({ ...local, baseRev: 1, savedAt: Date.now() }))
    server.state = { draft: { text: 'short', attachments: [], rev: 2 }, scroll: null }
    const originalSet = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.endsWith(':conflicts')) throw new Error('Quota exceeded')
      originalSet.call(this, key, value)
    })
    const h = setup({ draft: empty })
    await vi.waitFor(() => expect(h.result.current.conflictAvailable).toBe(true))
    h.rerender({ draft: { text: 'short', attachments: [] } })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(JSON.parse(localStorage.getItem(key)!).text).toBe(local.text)
    expect(server.saves).toEqual([])
  })

  it('malformed attachment recovery records are ignored without crashing draft reconciliation', async () => {
    localStorage.setItem(
      `${draftJournalKey('tab-1')}:conflicts`,
      JSON.stringify([{ text: 'bad', attachments: [null] }])
    )
    const h = setup({ draft: empty })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    expect(h.result.current.conflictAvailable).toBe(false)
    let recovered!: ChatDraft | null
    act(() => {
      recovered = h.result.current.recoverConflict({ text: 'current', attachments: [] })
    })
    expect(recovered).toEqual({ text: 'current', attachments: [] })
  })

  it('captures old ownership for an unmount flush and isolates journals by provider', async () => {
    const ownership = { id: 'old-provider-store', epoch: 3 }
    server.state = { draft: { ...empty, rev: 4 }, scroll: null, ownership }
    const h = setup({ draft: empty, mode: 'claude-chat' })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    h.rerender({ draft: { text: 'old provider edit', attachments: [] }, mode: 'claude-chat' })
    expect(
      JSON.parse(localStorage.getItem(draftJournalKey('tab-1', 'local', 'claude-chat'))!)
    ).toMatchObject({ ownership })
    expect(localStorage.getItem(draftJournalKey('tab-1', 'local', 'codex-chat'))).toBeNull()
    h.unmount()
    await vi.waitFor(() => expect(server.saves).toHaveLength(1))
    expect(server.saves[0]).toMatchObject({
      expectedMode: 'claude-chat',
      expectedOwnership: ownership,
      draft: { text: 'old provider edit' }
    })
  })

  it('a same-provider replacement ownership conflicts even when draft revision matches', async () => {
    const key = draftJournalKey('tab-1', 'local', 'claude-chat')
    localStorage.setItem(
      key,
      JSON.stringify({
        text: 'old A edit',
        attachments: [],
        baseRev: 5,
        ownership: { id: 'old-A', epoch: 1 },
        savedAt: Date.now()
      })
    )
    server.state = {
      draft: { text: 'new A draft', attachments: [], rev: 5 },
      scroll: null,
      ownership: { id: 'new-A', epoch: 1 }
    }
    const h = setup({ draft: empty, mode: 'claude-chat' })
    await vi.waitFor(() => expect(h.result.current.conflictAvailable).toBe(true))
    h.rerender({ draft: { text: 'old A edit', attachments: [] }, mode: 'claude-chat' })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toEqual([])
    expect(h.result.current.saved?.text).toBe('new A draft')
  })

  it('late acknowledged save cannot remove a newer owner journal or overwrite its cached draft', async () => {
    const oldOwnership = { id: 'old-A', epoch: 1 }
    const newOwnership = { id: 'new-A', epoch: 1 }
    server.state = { draft: { ...empty, rev: 1 }, scroll: null, ownership: oldOwnership }
    let finish!: () => void
    server.delays.set(
      'same text',
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const client = new QueryClient()
    const h = setup({ draft: empty, mode: 'claude-chat' }, client)
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    h.rerender({ draft: { text: 'same text', attachments: [] }, mode: 'claude-chat' })
    await act(() => vi.advanceTimersByTimeAsync(400))
    h.unmount()
    const key = draftJournalKey('tab-1', 'local', 'claude-chat')
    const newer = {
      text: 'same text',
      attachments: [],
      baseRev: 9,
      ownership: newOwnership,
      savedAt: Date.now()
    }
    localStorage.setItem(key, JSON.stringify(newer))
    client.setQueryData(['tabState', 'tab-1', 'claude-chat'], {
      draft: { text: 'new owner cached draft', attachments: [], rev: 9 },
      scroll: null,
      ownership: newOwnership
    })
    await act(async () => {
      finish()
    })
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(newer)
    expect(client.getQueryData(['tabState', 'tab-1', 'claude-chat'])).toMatchObject({
      draft: { text: 'new owner cached draft' },
      ownership: newOwnership
    })
    client.clear()
  })

  it('reconnect refetches replacement ownership in the same mounted provider and fences its old pending save', async () => {
    const oldOwner = { id: 'old-A', epoch: 1 }
    const newOwner = { id: 'new-A', epoch: 2 }
    server.state = { draft: { ...empty, rev: 1 }, scroll: null, ownership: oldOwner }
    let acknowledge!: () => void
    server.delays.set(
      'local pending edit',
      new Promise((resolve) => {
        acknowledge = resolve
      })
    )
    const h = setup({ draft: empty, mode: 'claude-chat' })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    const local = { text: 'local pending edit', attachments: [] }
    h.rerender({ draft: local, mode: 'claude-chat' })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves[0].expectedOwnership).toEqual(oldOwner)
    server.state = {
      draft: { text: 'replacement owner draft', attachments: [], rev: 10 },
      scroll: null,
      ownership: newOwner
    }
    server.rev = 10
    await act(async () => {
      await h.result.current.retry()
    })
    await vi.waitFor(() => expect(h.result.current.conflictAvailable).toBe(true))
    await act(async () => {
      acknowledge()
    })
    expect(server.state.ownership).toEqual(newOwner)
    expect(server.state.draft.text).toBe('replacement owner draft')
    let recovered!: ChatDraft | null
    act(() => {
      recovered = h.result.current.recoverConflict(local)
    })
    h.rerender({ draft: recovered!, mode: 'claude-chat' })
    const journal = JSON.parse(
      localStorage.getItem(draftJournalKey('tab-1', 'local', 'claude-chat'))!
    )
    expect(journal).toMatchObject({ baseRev: 10, ownership: newOwner })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves.at(-1)).toMatchObject({ expectedOwnership: newOwner, draft: recovered })
  })

  it('reconnect retains both local and newer remote drafts even when ownership did not change', async () => {
    const ownership = { id: 'same-owner', epoch: 1 }
    server.state = { draft: { ...empty, rev: 1 }, scroll: null, ownership }
    const h = setup({ draft: empty, mode: 'claude-chat' })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    const local = { text: 'local offline edit', attachments: [] }
    h.rerender({ draft: local, mode: 'claude-chat' })
    server.state = {
      draft: { text: 'newer other-device draft', attachments: [], rev: 2 },
      scroll: null,
      ownership
    }
    await act(async () => {
      await h.result.current.retry()
    })
    await vi.waitFor(() => expect(h.result.current.conflictAvailable).toBe(true))
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.saves).toEqual([])
    expect(server.state.draft.text).toBe('newer other-device draft')
    let recovered!: ChatDraft | null
    act(() => {
      recovered = h.result.current.recoverConflict(local)
    })
    expect(recovered?.text).toBe('local offline edit\n\nnewer other-device draft')
  })

  it('reconnect while its own save is unacknowledged is not a conflict (send right after typing)', async () => {
    const ownership = { id: 'same-owner', epoch: 1 }
    server.state = { draft: { ...empty, rev: 1 }, scroll: null, ownership }
    server.rev = 1
    let acknowledge!: () => void
    server.ackDelays.set(
      'Commit',
      new Promise((resolve) => {
        acknowledge = resolve
      })
    )
    const h = setup({ draft: empty, mode: 'claude-chat' })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    h.rerender({ draft: { text: 'Commit', attachments: [] }, mode: 'claude-chat' })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.state.draft).toMatchObject({ text: 'Commit', rev: 2 })
    // Enter sends it: the composer clears while the save's reply is still on its way.
    h.rerender({ draft: empty, mode: 'claude-chat' })
    await act(() => vi.advanceTimersByTimeAsync(400))
    // The computer comes back "ready": the composer re-reads its own unacknowledged save.
    await act(async () => {
      await h.result.current.retry()
    })
    expect(h.result.current.conflictAvailable).toBe(false)
    await act(async () => {
      acknowledge()
    })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(h.result.current.conflictAvailable).toBe(false)
    expect(server.state.draft.text).toBe('')
    expect(localStorage.getItem(draftJournalKey('tab-1', 'local', 'claude-chat'))).toBeNull()
  })

  it('a reload before its own save was acknowledged restores the newer journal, no conflict', async () => {
    const ownership = { id: 'same-owner', epoch: 1 }
    server.state = { draft: { ...empty, rev: 1 }, scroll: null, ownership }
    server.rev = 1
    // The reload kills the old page: its reply never arrives, its queued save never runs.
    server.ackDelays.set('Commit', new Promise(() => undefined))
    const before = setup({ draft: empty, mode: 'claude-chat' })
    await vi.waitFor(() => expect(before.result.current.loaded).toBe(true))
    before.rerender({ draft: { text: 'Commit', attachments: [] }, mode: 'claude-chat' })
    await act(() => vi.advanceTimersByTimeAsync(400))
    before.rerender({ draft: empty, mode: 'claude-chat' })
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.state.draft).toMatchObject({ text: 'Commit', rev: 2 })

    const after = setup({ draft: empty, mode: 'claude-chat' }, new QueryClient())
    await vi.waitFor(() => expect(after.result.current.loaded).toBe(true))
    // `loaded` is already true from the journal: let the server read land too.
    await act(() => vi.advanceTimersByTimeAsync(50))
    expect(after.result.current.conflictAvailable).toBe(false)
    expect(after.result.current.saved).toEqual(empty)
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(server.state.draft).toMatchObject({ text: '', rev: 3 })
  })

  it('old unscoped journals require explicit recovery into the selected provider', async () => {
    const oldKey = draftJournalKey('tab-1')
    localStorage.setItem(
      oldKey,
      JSON.stringify({ text: 'provider unknown', attachments: [], baseRev: 0, savedAt: Date.now() })
    )
    server.state = {
      draft: { ...empty, rev: 0 },
      scroll: null,
      ownership: { id: 'codex', epoch: 1 }
    }
    const h = setup({ draft: empty, mode: 'codex-chat' })
    await vi.waitFor(() => expect(h.result.current.loaded).toBe(true))
    expect(h.result.current.saved).toBeNull()
    expect(h.result.current.legacyAvailable).toBe(true)
    expect(localStorage.getItem(oldKey)).not.toBeNull()
    let recovered!: ChatDraft | null
    act(() => {
      recovered = h.result.current.recoverLegacy(empty)
    })
    expect(recovered?.text).toBe('provider unknown')
    expect(localStorage.getItem(oldKey)).toBeNull()
    expect(localStorage.getItem(draftJournalKey('tab-1', 'local', 'codex-chat'))).toContain(
      'provider unknown'
    )
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
    await act(async () => {
      await h.result.current.retry()
    })
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
