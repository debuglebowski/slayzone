import { describe, expect, it } from 'vitest'
import { describeDirectLink } from './direct-link-status'

describe('describeDirectLink (Settings → Diagnostics)', () => {
  it('says how each computer is reached', () => {
    expect(
      describeDirectLink(
        [
          {
            hubId: 'local',
            computers: [
              {
                computerId: 'c1',
                path: 'direct',
                transport: 'ws',
                address: '127.0.0.1:5001',
                leases: 2
              },
              { computerId: 'c2', path: 'relay', reason: 'probe', retryInMs: 45_200 }
            ]
          }
        ],
        { terminals: 2, chats: 1 }
      )
    ).toEqual({
      rows: [
        { computerId: 'c1', path: 'Direct', detail: 'WebSocket · 127.0.0.1:5001 · 2 open' },
        {
          computerId: 'c2',
          path: 'Hub relay',
          detail: 'not reachable from here · retrying in 46 s'
        }
      ],
      summary: '2 terminals and 1 chat on the direct link'
    })
  })

  it('names the hub only when there is more than one', () => {
    const rows = describeDirectLink(
      [
        {
          hubId: 'a',
          computers: [
            { computerId: 'c1', path: 'direct', transport: 'ws', address: 'x:1', leases: 1 }
          ]
        },
        {
          hubId: 'b',
          computers: [{ computerId: 'c2', path: 'relay', reason: 'deadline', retryInMs: 1 }]
        }
      ],
      { terminals: 0, chats: 0 }
    ).rows
    expect(rows.map((r) => r.hubId)).toEqual(['a', 'b'])
    expect(rows[1]?.detail).toBe('no connection in time · retrying in 1 s')
  })

  it('says everything goes through the hub when nothing is direct', () => {
    expect(describeDirectLink([], { terminals: 0, chats: 0 })).toEqual({
      rows: [],
      summary: 'Everything goes through the hub.'
    })
  })

  it('says when a computer is reached over WebRTC, and which way', () => {
    const rows = describeDirectLink(
      [
        {
          hubId: 'a',
          computers: [
            {
              computerId: 'c1',
              path: 'direct',
              transport: 'webrtc',
              address: null,
              route: 'local',
              leases: 2
            },
            {
              computerId: 'c2',
              path: 'direct',
              transport: 'webrtc',
              address: null,
              route: 'stun',
              leases: 1
            },
            { computerId: 'c3', path: 'relay', reason: 'rtc', retryInMs: 60_000 }
          ]
        }
      ],
      { terminals: 3, chats: 0 }
    ).rows
    expect(rows.map((r) => r.detail)).toEqual([
      'WebRTC · local network · 2 open',
      'WebRTC · through NAT (STUN) · 1 open',
      'WebRTC could not connect · retrying in 60 s'
    ])
  })
})
