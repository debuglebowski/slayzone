/** Seed/read the owning computer through test-only, owner-checked ports. */
import type { Page } from '@playwright/test'
import type { ChatEventRow } from './chat-task-core'

export const SEED_LIMITS = { maxEvents: 1000, maxBatchBytes: 6 * 1024 * 1024 } as const

export function* chatEventSeedBatches(
  tabId: string,
  events: ReadonlyArray<Record<string, unknown>>
) {
  let fromSeq = 0
  do {
    const batch: Array<Record<string, unknown> & { kind: string }> = []
    let bytes = 0
    while (fromSeq + batch.length < events.length && batch.length < SEED_LIMITS.maxEvents) {
      const event = events[fromSeq + batch.length],
        size = Buffer.byteLength(JSON.stringify(event))
      if (size > SEED_LIMITS.maxBatchBytes) throw new Error('Seed event exceeds byte limit')
      if (bytes + size > SEED_LIMITS.maxBatchBytes) break
      if (typeof event.kind !== 'string') throw new Error('Seed event kind is missing')
      batch.push({ ...event, kind: event.kind })
      bytes += size
    }
    yield { tabId, fromSeq, events: batch }
    fromSeq += batch.length
  } while (fromSeq < events.length)
}

export async function seedChatEvents(
  page: Page,
  tabId: string,
  events: ReadonlyArray<Record<string, unknown>>
): Promise<void> {
  for (const batch of chatEventSeedBatches(tabId, events))
    await page.evaluate(
      (input) => window.getTrpcVanillaClient().chat.testSeedEvents.mutate(input),
      batch
    )
}

export async function readChatEvents(page: Page, tabId: string): Promise<ChatEventRow[]> {
  const events: ChatEventRow[] = []
  let afterSeq = -1
  for (;;) {
    const rows = await page.evaluate(
      (input) => window.getTrpcVanillaClient().chat.testReadEvents.query(input),
      { tabId, afterSeq, limit: 1000 }
    )
    if (!rows.length) return events
    for (const row of rows) {
      if (row.seq <= afterSeq) throw new Error('Invalid computer event cursor')
      afterSeq = row.seq
      events.push(row as ChatEventRow)
    }
  }
}

export function chatProjection(
  page: Page,
  tabId: string,
  action: 'read' | 'corrupt-page' | 'corrupt-checkpoint' = 'read'
) {
  return page.evaluate((input) => window.getTrpcVanillaClient().chat.testProjection.mutate(input), {
    tabId,
    action
  })
}
