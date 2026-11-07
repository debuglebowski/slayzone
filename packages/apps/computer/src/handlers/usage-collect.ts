/**
 * `usage.collect`: this computer's agent usage logs, parsed here (the same parsers
 * the hub used on its own disk) from the hub's cursors. Reads only the agents' own
 * log dirs under this computer's home; answers records + the new cursors.
 *
 * Paged: a reply never carries more than {@link DEFAULT_PAGE_BYTES} of records. A
 * whole backlog (a first collect: 81 MiB measured) in one message neared the hub's
 * 100 MiB WebSocket limit — past it the socket closes and every terminal on this
 * computer detaches. The rest waits here under a token the hub asks for next.
 *
 * @module computer/handlers/usage-collect
 */
import { randomUUID } from 'node:crypto'
import {
  HubToComputerMethods,
  usageCollectParamsSchema,
  type UsageCollectResult
} from '@slayzone/computer-transport/shared'
import {
  collectUsage,
  type ParseResult,
  type UsageCursors
} from '@slayzone/usage-analytics/collect'
import type { HandlerContext, HubMethodTable } from './types'

/** Records per reply, by their JSON size: far under the 100 MiB message limit. */
export const DEFAULT_PAGE_BYTES = 8 * 1024 * 1024
/** A collect the hub stopped asking for is dropped after this. */
const PAGES_TTL_MS = 10 * 60_000
/** Collects held at once (one per refresh; a few if refreshes overlap). */
const MAX_HELD = 4

type Entry = UsageCollectResult['results'][number]

/**
 * Split results into pages of at most `budget` bytes of records. A file larger than
 * a page spans several: every chunk but its last is `complete: false` and keeps the
 * file's old cursor, so its cursor only moves once all its records are delivered.
 */
export function pageUsage(
  results: ParseResult[],
  cursors: UsageCursors,
  budget: number
): Entry[][] {
  const pages: Entry[][] = []
  let page: Entry[] = []
  let bytes = 0
  const close = () => {
    if (page.length) pages.push(page)
    page = []
    bytes = 0
  }
  for (const result of results) {
    const header = result.sourceFile.length + 96
    let chunk: Entry['records'] = []
    const flushPartial = () => {
      page.push({
        sourceFile: result.sourceFile,
        fileMtimeMs: result.fileMtimeMs,
        endOffset: cursors[result.sourceFile]?.offset ?? 0,
        complete: false,
        records: chunk
      })
      chunk = []
      close()
    }
    if (bytes + header > budget) close()
    bytes += header
    for (const record of result.records) {
      const size = JSON.stringify(record).length + 1
      if (bytes + size > budget && (chunk.length > 0 || page.length > 0)) {
        if (chunk.length > 0) flushPartial()
        else close()
        bytes = header
      }
      chunk.push(record as unknown as Entry['records'][number])
      bytes += size
    }
    page.push({
      sourceFile: result.sourceFile,
      fileMtimeMs: result.fileMtimeMs,
      endOffset: result.endOffset,
      records: chunk
    })
  }
  close()
  return pages.length ? pages : [[]]
}

export function createUsageCollectHandlers(
  _ctx: HandlerContext,
  opts: { pageBytes?: number; collect?: typeof collectUsage } = {}
): HubMethodTable {
  const budget = opts.pageBytes ?? DEFAULT_PAGE_BYTES
  const collect = opts.collect ?? collectUsage
  const held = new Map<string, { pages: Entry[][]; expiresAt: number }>()

  const reply = (token: string, pages: Entry[][], index: number): UsageCollectResult => {
    const last = index + 1 >= pages.length
    if (last) held.delete(token)
    return {
      results: pages[index] ?? [],
      ...(last ? {} : { next: { token, index: index + 1 } })
    }
  }

  async function usageCollect(raw: unknown): Promise<UsageCollectResult> {
    const { cursors, page } = usageCollectParamsSchema.parse(raw)
    const now = Date.now()
    for (const [token, h] of held) if (h.expiresAt < now) held.delete(token)
    if (page) {
      const h = held.get(page.token)
      // Expired or unknown: nothing more here; the hub resumes from its cursors.
      if (!h) return { results: [] }
      h.expiresAt = now + PAGES_TTL_MS
      return reply(page.token, h.pages, page.index)
    }
    const pages = pageUsage(await collect(cursors), cursors, budget)
    if (pages.length === 1) return { results: pages[0] ?? [] }
    while (held.size >= MAX_HELD) held.delete(held.keys().next().value as string)
    const token = randomUUID()
    held.set(token, { pages, expiresAt: now + PAGES_TTL_MS })
    return reply(token, pages, 0)
  }
  return { [HubToComputerMethods.usageCollect]: usageCollect }
}
