/**
 * How Settings → Diagnostics describes the direct link (docs/direct-link.md): for
 * each computer, whether this client reaches it directly or through the hub, and why.
 */
import type { DirectLinkComputerStatus } from '@slayzone/transport/direct-client'

export interface DirectLinkRow {
  /** Set only when more than one hub is connected. */
  hubId?: string
  computerId: string
  path: 'Direct' | 'Hub relay'
  detail: string
}

const REASONS: Record<'probe' | 'deadline' | 'refused' | 'rtc', string> = {
  probe: 'not reachable from here',
  deadline: 'no connection in time',
  refused: 'refused the connection',
  rtc: 'WebRTC could not connect'
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export function describeDirectLink(
  hubs: Array<{ hubId: string; computers: DirectLinkComputerStatus[] }>,
  counts: { terminals: number; chats: number }
): { rows: DirectLinkRow[]; summary: string } {
  const named = hubs.length > 1
  const rows: DirectLinkRow[] = []
  for (const hub of hubs) {
    for (const c of hub.computers) {
      rows.push({
        ...(named ? { hubId: hub.hubId } : {}),
        computerId: c.computerId,
        path: c.path === 'direct' ? 'Direct' : 'Hub relay',
        detail:
          c.path === 'direct'
            ? `${c.transport === 'webrtc' ? 'WebRTC' : c.address} · ${c.leases} open`
            : `${REASONS[c.reason]} · retrying in ${Math.ceil(c.retryInMs / 1000)} s`
      })
    }
  }
  const direct = counts.terminals + counts.chats
  return {
    rows,
    summary:
      direct === 0
        ? 'Everything goes through the hub.'
        : `${plural(counts.terminals, 'terminal')} and ${plural(counts.chats, 'chat')} on the direct link`
  }
}
