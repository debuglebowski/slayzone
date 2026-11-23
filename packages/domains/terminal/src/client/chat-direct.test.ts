/**
 * Chat reads and simple commands over the direct link when the tab has one
 * (docs/direct-link.md), the hub otherwise — and the hub whenever the direct path
 * fails, so nothing a user does is lost to a dropped link.
 */
import { describe, expect, it, vi } from 'vitest'
import { shareToolDetailReads } from './chat-tool-details'
import { chatViaDirect, openChatTimeline } from './chat-direct'

function hub() {
  const calls: string[] = []
  const q = (name: string) =>
    vi.fn(async (_input: unknown) => {
      calls.push(name)
      return { from: 'hub', name }
    })
  return {
    calls,
    client: {
      chat: {
        openTimeline: { query: q('openTimeline') },
        getReplay: { query: q('getReplay') },
        readBlob: { query: q('readBlob') },
        timelinePages: { query: q('timelinePages') },
        toolDetail: { query: q('toolDetail') },
        searchTimeline: { query: q('searchTimeline') },
        respondPermission: { mutate: q('respondPermission') },
        sendToolResult: { mutate: q('sendToolResult') }
      }
    }
  }
}

function direct(fail?: { code?: string }) {
  const calls: string[] = []
  const q = (name: string) =>
    vi.fn(async (_input: unknown) => {
      calls.push(name)
      if (fail) throw Object.assign(new Error('direct failed'), { data: { code: fail.code } })
      return { from: 'direct', name }
    })
  return {
    calls,
    client: {
      chat: {
        openTimeline: { query: q('openTimeline') },
        getReplay: { query: q('getReplay') },
        readBlob: { query: q('readBlob') },
        timelinePages: { query: q('timelinePages') },
        toolDetail: { query: q('toolDetail') },
        searchTimeline: { query: q('searchTimeline') },
        respondPermission: { mutate: q('respondPermission') },
        sendToolResult: { mutate: q('sendToolResult') }
      }
    }
  }
}

describe('chatViaDirect', () => {
  it('uses the hub without a lease', async () => {
    const h = hub()
    const c = chatViaDirect(h.client, null, () => undefined)
    expect(await c.getReplay({ tabId: 't', afterSeq: -1 })).toEqual({
      from: 'hub',
      name: 'getReplay'
    })
  })

  it('reads direct while there is a lease; permission and tool answers always go through the hub (its running-in-terminal guard)', async () => {
    const h = hub()
    const d = direct()
    const c = chatViaDirect(h.client, d.client as never, () => undefined)
    await c.openTimeline({ tabId: 't', version: 'v' })
    await c.timelinePages({ tabId: 't', pages: [0], asOfSeq: 1, epoch: 1 })
    await c.searchTimeline({ tabId: 't', query: 'q' })
    await c.readBlob({ tabId: 't', sha256: 'a'.repeat(64), offset: 0 })
    await c.respondPermission({
      tabId: 't',
      args: { requestId: 'r', decision: { behavior: 'allow' } }
    })
    await c.sendToolResult({ tabId: 't', args: { toolUseId: 'u', content: 'c' } })
    expect(d.calls).toEqual(['openTimeline', 'timelinePages', 'searchTimeline', 'readBlob'])
    expect(h.calls).toEqual(['respondPermission', 'sendToolResult'])
  })

  it('only asks for direct previews when the hub can recover their details', async () => {
    const h = hub()
    const d = direct()
    const input = { tabId: 't', version: 'v', toolPreviews: true }
    const older = chatViaDirect(
      h.client,
      d.client as never,
      () => undefined,
      async () => false
    )
    await older.openTimeline(input)
    expect(d.client.chat.openTimeline.query).toHaveBeenLastCalledWith({
      ...input,
      toolPreviews: false
    })
    const current = chatViaDirect(
      h.client,
      d.client as never,
      () => undefined,
      async () => true
    )
    await current.openTimeline(input)
    expect(d.client.chat.openTimeline.query).toHaveBeenLastCalledWith(input)
  })

  it('keeps tool previews when the fallback hub only lacks thinking stubs', async () => {
    const h = hub()
    const d = direct()
    const io = chatViaDirect(
      h.client,
      d.client as never,
      () => undefined,
      async (withDisplay) => !withDisplay
    )
    const input = { tabId: 't', version: 'v', toolPreviews: true }
    await io.openTimeline({ ...input, display: { hideThinking: true } })
    expect(d.client.chat.openTimeline.query).toHaveBeenCalledWith(input)
    const page = { tabId: 't', pages: [0], asOfSeq: 1, epoch: 1, toolPreviews: true }
    await io.timelinePages({ ...page, display: { hideThinking: true } })
    expect(d.client.chat.timelinePages.query).toHaveBeenCalledWith(page)
  })

  it('a failed direct read falls back to the hub and reports the link lost', async () => {
    const h = hub()
    const lost = vi.fn()
    const c = chatViaDirect(
      h.client,
      direct({ code: 'INTERNAL_SERVER_ERROR' }).client as never,
      lost
    )
    expect(await c.getReplay({ tabId: 't', afterSeq: 0 })).toEqual({
      from: 'hub',
      name: 'getReplay'
    })
    expect(lost).toHaveBeenCalled()
  })
})

it('shares a tool detail read while either card still needs it', async () => {
  const value = { id: 'tool', name: 'Write', input: {}, status: 'done' } as const
  let finish: (v: typeof value) => void = () => undefined
  const body = new Promise<typeof value>((resolve) => {
    finish = resolve
  })
  const source = vi.fn((_ref: unknown, _signal: AbortSignal) => body)
  const read = shareToolDetailReads(source)
  const ref = { instance: 'chat', epoch: 0, row: 1, toolUseId: value.id }
  const first = new AbortController()
  const second = new AbortController()
  const cancelled = expect(read(ref, first.signal)).rejects.toThrow(/cancelled/)
  const result = read(ref, second.signal)
  first.abort()
  await cancelled
  expect(source).toHaveBeenCalledTimes(1)
  expect(source.mock.calls[0][1].aborted).toBe(false)
  finish(value)
  await expect(result).resolves.toEqual(value)
})

it('tries ordinary previews before full history on a computer without display settings', async () => {
  const paged = { kind: 'paged', snapshot: { toolPreviews: true } }
  const io = {
    openTimeline: vi
      .fn()
      .mockResolvedValueOnce({ kind: 'full' })
      .mockResolvedValueOnce({ kind: 'full' })
      .mockResolvedValueOnce(paged)
  }
  expect(await openChatTimeline(io, 't', { hideThinking: true })).toBe(paged)
  expect(io.openTimeline).toHaveBeenCalledTimes(3)
  expect(io.openTimeline.mock.calls[0][0]).toMatchObject({
    display: { hideThinking: true, windowed: true }
  })
  expect(io.openTimeline.mock.calls[2][0]).toMatchObject({ tabId: 't', toolPreviews: true })
  expect(io.openTimeline.mock.calls[2][0]).not.toHaveProperty('display')
})
