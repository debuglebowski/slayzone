/**
 * A chat tab's history reads over the direct link when the tab has one
 * (docs/direct-link.md), with the hub's types and the hub as the fallback: a direct
 * read that fails is answered by the hub, and the link is reported lost. The
 * computer returns exactly what the hub would relay, so its answers carry the hub's
 * output types.
 *
 * Permission and tool answers always go through the hub: its relay refuses them
 * while the conversation runs in the terminal, and syncs the chat's bootstrap first
 * — checks only the hub can make.
 *
 * @module terminal/client/chat-direct
 */
import { isChatReplayPage, type ChatHistoryPageEvent } from '@slayzone/terminal-contracts'
import { noteDirectUse, type DirectLease } from '@slayzone/transport/direct-client'

type Query<I, O> = { query(input: I): Promise<O> }
type Mutation<I, O> = { mutate(input: I): Promise<O> }

/** The hub chat procedures this module routes (inputs as the hub takes them). */
export interface ChatHubSlice {
  chat: {
    openTimeline: Query<{ tabId: string; version: string }, unknown>
    /** With `page`: one bounded page (an older peer answers the whole replay instead). */
    getReplay: Query<
      { tabId: string; afterSeq: number; page?: { maxBytes?: number; maxEvents?: number } },
      unknown
    >
    timelinePages: Query<
      { tabId: string; pages: number[]; asOfSeq: number; epoch: number },
      unknown
    >
    searchTimeline: Query<{ tabId: string; query: string }, unknown>
    respondPermission: Mutation<{ tabId: string; args: never }, unknown>
    sendToolResult: Mutation<{ tabId: string; args: never }, unknown>
  }
}

type In<P> = P extends { query(input: infer I): unknown }
  ? I
  : P extends { mutate(input: infer I): unknown }
    ? I
    : never
type Out<P> = P extends { query(input: never): Promise<infer O> }
  ? O
  : P extends { mutate(input: never): Promise<infer O> }
    ? O
    : never

/** What went direct since load (diagnostics, e2e). */
const stats = { reads: 0, events: 0 }
const linkedTabs = new Set<string>()

/** Tabs on the direct link now, and what went direct (diagnostics, e2e). */
export function directChatStatus(): {
  tabIds: string[]
  reads: number
  events: number
} {
  return { tabIds: [...linkedTabs], ...stats }
}

/** A tab's direct link came up (true) or went (false). */
export function noteDirectChatLink(tabId: string, linked: boolean): void {
  if (linked) linkedTabs.add(tabId)
  else linkedTabs.delete(tabId)
  noteDirectUse('chat', tabId, linked)
}

/** One event arrived over the direct link. */
export function noteDirectChatEvent(): void {
  stats.events++
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __slayzone_directChat?: () => unknown }).__slayzone_directChat =
    directChatStatus
}

export function chatViaDirect<H extends ChatHubSlice>(
  hub: H,
  direct: DirectLease['client'] | null,
  lost: () => void
) {
  type C = H['chat']
  async function read<K extends 'openTimeline' | 'getReplay' | 'timelinePages' | 'searchTimeline'>(
    name: K,
    input: In<C[K]>
  ): Promise<Out<C[K]>> {
    const viaHub = () => (hub.chat[name] as unknown as Query<In<C[K]>, Out<C[K]>>).query(input)
    if (!direct) return viaHub()
    try {
      const out = (await (direct.chat[name] as unknown as Query<In<C[K]>, Out<C[K]>>).query(
        input
      )) as Out<C[K]>
      stats.reads++
      return out
    } catch {
      lost()
      return viaHub()
    }
  }
  return {
    openTimeline: (input: In<C['openTimeline']>) => read('openTimeline', input),
    getReplay: (input: In<C['getReplay']>) => read('getReplay', input),
    timelinePages: (input: In<C['timelinePages']>) => read('timelinePages', input),
    searchTimeline: (input: In<C['searchTimeline']>) => read('searchTimeline', input),
    respondPermission: (input: In<C['respondPermission']>) =>
      (
        hub.chat.respondPermission as unknown as Mutation<
          In<C['respondPermission']>,
          Out<C['respondPermission']>
        >
      ).mutate(input),
    sendToolResult: (input: In<C['sendToolResult']>) =>
      (
        hub.chat.sendToolResult as unknown as Mutation<
          In<C['sendToolResult']>,
          Out<C['sendToolResult']>
        >
      ).mutate(input)
  }
}

/** A whole replay: saved events after a seq, and what streams right now. */
export interface WholeChatReplay {
  events: ChatHistoryPageEvent[]
  live: { afterSeq: number; liveSeq: number; events: unknown[] }
}

/**
 * A tab's replay after `afterSeq`, one bounded page per read (2026-11-14: one
 * whole-history answer closed the computer's socket). An older hub or computer
 * answers the whole replay at once (no `hasMore`): that is the last page. Null:
 * `stale` went true between reads.
 */
export async function readReplayPages(
  io: {
    getReplay(input: {
      tabId: string
      afterSeq: number
      page: { maxBytes?: number; maxEvents?: number }
    }): Promise<unknown>
  },
  tabId: string,
  afterSeq: number,
  stale: () => boolean = () => false
): Promise<WholeChatReplay | null> {
  const events: ChatHistoryPageEvent[] = []
  for (let from = afterSeq; ; ) {
    const answer = await io.getReplay({ tabId, afterSeq: from, page: {} })
    if (stale()) return null
    if (!isChatReplayPage(answer)) {
      const whole = answer as WholeChatReplay
      return { events: [...events, ...whole.events], live: whole.live }
    }
    events.push(...answer.events)
    if (!answer.hasMore) return { events, live: answer.live }
    const last = answer.events.at(-1)
    if (!last) throw new Error('Chat history page was empty but not the last one')
    from = last.seq
  }
}
