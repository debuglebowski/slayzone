import type { TimelineCheckpointRow, TimelinePageRow, TimelineWrite } from '../chat-timeline-store'
import type { TimelineProjectionStore } from './chat-timeline-projection'

/** Already encoded by the projection's thread; the database owner only commits bytes. */
export interface EncodedTimelineWrite {
  dropPagesFrom: number | null
  pages: Array<{ page: number; value: string }>
  checkpoint: string | null
}

/** Private computer-local seam, never accepted from a client or sent to the hub. */
export interface TimelineRecordStore {
  load(key: string): Promise<string | null>
  pageIds(): Promise<number[]>
  save(write: EncodedTimelineWrite): Promise<void>
  discard(): Promise<void>
}

/** Read at most one stored page at a time, decoding on the projection's thread. */
export function timelineStoreFromRecords(records: TimelineRecordStore): TimelineProjectionStore {
  async function load<T>(key: string): Promise<T | null> {
    const value = await records.load(key)
    return value === null ? null : (JSON.parse(value) as T)
  }
  return {
    records,
    loadCheckpoint: () => load<TimelineCheckpointRow>('checkpoint'),
    async loadPages(wanted) {
      const found: Array<{ page: number; rows: string }> = []
      for (const page of wanted) {
        const value = await load<TimelinePageRow>(`page:${page}`)
        if (value) found.push({ page, rows: value.rows })
      }
      return found
    },
    async loadSummaries() {
      const found: Array<{ page: number; summary: string }> = []
      for (const page of await records.pageIds()) {
        const value = await load<TimelinePageRow>(`page:${page}`)
        if (value) found.push({ page, summary: value.summary })
      }
      return found
    },
    async searchPages(needle) {
      const found: number[] = []
      for (const page of await records.pageIds()) {
        const value = await load<TimelinePageRow>(`page:${page}`)
        if (value?.searchText.includes(needle)) found.push(page)
      }
      return found
    },
    save: (write: TimelineWrite) =>
      records.save({
        dropPagesFrom: write.dropPagesFrom,
        pages: write.pages.map((page) => ({ page: page.page, value: JSON.stringify(page) })),
        checkpoint: write.checkpoint === null ? null : JSON.stringify(write.checkpoint)
      }),
    discard: () => records.discard()
  }
}
