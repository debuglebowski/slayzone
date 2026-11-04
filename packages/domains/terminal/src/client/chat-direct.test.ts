/**
 * Chat reads and simple commands over the direct link when the tab has one
 * (docs/direct-link.md), the hub otherwise — and the hub whenever the direct path
 * fails, so nothing a user does is lost to a dropped link.
 */
import { describe, expect, it, vi } from 'vitest'
import { chatViaDirect } from './chat-direct'

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
        timelinePages: { query: q('timelinePages') },
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
        timelinePages: { query: q('timelinePages') },
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

  it('reads and writes direct while there is a lease', async () => {
    const h = hub()
    const d = direct()
    const c = chatViaDirect(h.client, d.client as never, () => undefined)
    await c.openTimeline({ tabId: 't', version: 'v' })
    await c.timelinePages({ tabId: 't', pages: [0], asOfSeq: 1, epoch: 1 })
    await c.searchTimeline({ tabId: 't', query: 'q' })
    await c.respondPermission({
      tabId: 't',
      args: { requestId: 'r', decision: { behavior: 'allow' } }
    })
    await c.sendToolResult({ tabId: 't', args: { toolUseId: 'u', content: 'c' } })
    expect(d.calls).toEqual([
      'openTimeline',
      'timelinePages',
      'searchTimeline',
      'respondPermission',
      'sendToolResult'
    ])
    expect(h.calls).toEqual([])
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

  it('a refused direct write (grant gone) goes to the hub; another failure is not repeated there', async () => {
    const h = hub()
    const refused = chatViaDirect(
      h.client,
      direct({ code: 'FORBIDDEN' }).client as never,
      () => undefined
    )
    await refused.sendToolResult({ tabId: 't', args: { toolUseId: 'u', content: 'c' } })
    expect(h.calls).toEqual(['sendToolResult'])
    const broken = chatViaDirect(
      h.client,
      direct({ code: 'INTERNAL_SERVER_ERROR' }).client as never,
      () => undefined
    )
    await expect(
      broken.respondPermission({
        tabId: 't',
        args: { requestId: 'r', decision: { behavior: 'allow' } }
      })
    ).rejects.toThrow(/direct failed/)
    expect(h.calls).toEqual(['sendToolResult'])
  })
})
