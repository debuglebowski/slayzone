/**
 * Measurement (not a gate): what opening a chat costs on a REAL chat store, step by
 * step, with the production code of each step. Run by hand against a COPY:
 *
 *   SLZ_PERF_STATE_DIR=/tmp/slz-chat-bench/state npx vitest run \
 *     --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/domains/chat-runtime/src/server/__perf__/real-store-open.perf.test.ts
 *
 * The state dir holds `computer-runtime/<digest("perf")>/chat.sqlite` (a `.backup`
 * of the computer's store). Per conversation it reports:
 *  - cold hydrate read: every saved event read back a page at a time (hydrate's scan);
 *  - projection restore (stored checkpoint) and rebuild (none) times;
 *  - desktop open: `openSnapshot` time and bytes (raw / gzip), client decode time;
 *  - one older page: `pagesAsOf` time and bytes;
 *  - mobile open: the whole replay's bytes (raw / gzip) and its one reducer batch.
 * Writes JSON lines to SLZ_PERF_OUT (default /tmp/slz-chat-bench/results.jsonl).
 * Set SLZ_PERF_ALL_OPENS=1 to measure windowed payloads over every current tab.
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { performance } from 'node:perf_hooks'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { expect, test } from 'vitest'
import {
  CHAT_HISTORY_PAGE_MAX_BYTES,
  CHAT_HISTORY_PAGE_MAX_EVENTS,
  chatCapabilitiesForMode,
  type AgentEvent
} from '@slayzone/terminal-contracts'
import {
  TimelineProjection,
  type TimelineHistorySource,
  type TimelineProjectionStore
} from '@slayzone/terminal/timeline-projection'
import { decodeTimelineState } from '@slayzone/terminal/timeline-checkpoint'
import { timelineStoreFromRecords } from '@slayzone/terminal/timeline-records'
import { initialState, reducer } from '@slayzone/terminal/reducer'
import { openChatStorage } from '../storage'
import { createLocalChatData } from '../local-data'

const STATE_DIR = process.env.SLZ_PERF_STATE_DIR ?? ''
const OUT = process.env.SLZ_PERF_OUT ?? '/tmp/slz-chat-bench/results.jsonl'
const PICK = Number(process.env.SLZ_PERF_PICK ?? 6)
const ALL_OPENS = process.env.SLZ_PERF_ALL_OPENS === '1'
const BUDGET = { maxBytes: CHAT_HISTORY_PAGE_MAX_BYTES, maxEvents: CHAT_HISTORY_PAGE_MAX_EVENTS }

type Stored = { seq: number; event: AgentEvent; at?: number }

/** A projection store in memory: a rebuild that writes its pages nowhere durable. */
function memoryStore(): TimelineProjectionStore {
  const pages = new Map<number, { rows: string; summary: string }>()
  let checkpoint: Awaited<ReturnType<TimelineProjectionStore['loadCheckpoint']>> = null
  return {
    loadCheckpoint: async () => checkpoint,
    loadPages: async (wanted) =>
      wanted.flatMap((page) => {
        const p = pages.get(page)
        return p ? [{ page, rows: p.rows }] : []
      }),
    loadSummaries: async () => [...pages].map(([page, p]) => ({ page, summary: p.summary })),
    save: async (write) => {
      if (write.dropPagesFrom !== null)
        for (const page of [...pages.keys()]) if (page >= write.dropPagesFrom) pages.delete(page)
      for (const p of write.pages) pages.set(p.page, { rows: p.rows, summary: p.summary })
      checkpoint = write.checkpoint
    },
    searchPages: async () => [],
    discard: async () => {
      pages.clear()
      checkpoint = null
    }
  }
}

const ms = (n: number) => Math.round(n)
const kb = (n: number) => Math.round(n / 1024)

test.skipIf(!STATE_DIR || !existsSync(STATE_DIR))(
  'open cost per conversation on a real chat store',
  async () => {
    const store = openChatStorage({ stateDir: STATE_DIR, hubScope: 'perf' })
    const { data } = createLocalChatData(store)
    const all = store.compose((db) =>
      db
        .prepare(
          `SELECT c.id, c.tab_id AS tabId, c.mode, COUNT(*) AS n, MAX(e.seq) AS lastSeq,
                  SUM(LENGTH(CAST(e.event AS BLOB))) AS bytes
           FROM conversations c JOIN events e ON e.conversation_id = c.id
           GROUP BY c.id ORDER BY bytes DESC`
        )
        .all()
    ) as Array<{
      id: string
      tabId: string
      mode: string
      n: number
      lastSeq: number
      bytes: number
    }>
    // Distribution of the whole store (what a mobile replay would ship, per chat).
    const sizes = all.map((c) => c.bytes).sort((a, b) => a - b)
    const pct = (p: number) =>
      sizes[Math.min(sizes.length - 1, Math.floor((p / 100) * sizes.length))]
    const dist = {
      kind: 'distribution',
      conversations: all.length,
      p50KB: kb(pct(50)),
      p90KB: kb(pct(90)),
      p99KB: kb(pct(99)),
      maxKB: kb(sizes.at(-1) ?? 0),
      loadAvg1: Math.round(loadavg()[0]),
      cpus: cpus().length
    }
    console.log('[open-perf]', JSON.stringify(dist))
    writeFileSync(OUT, JSON.stringify(dist) + '\n')

    // The biggest few, then the 99th / 90th / 50th percentile chats (by bytes).
    const byRank = (p: number) => all[Math.min(all.length - 1, Math.floor((p / 100) * all.length))]
    const picked = [...all.slice(0, PICK), byRank(1), byRank(10), byRank(50)].filter(
      (c, i, a) => c && a.findIndex((x) => x.id === c.id) === i
    )

    for (const c of ALL_OPENS ? all : picked) {
      const owner = store.forTab(c.tabId)?.identity
      if (!owner || owner.id !== c.id) {
        console.log('[open-perf] skip (not the tab conversation)', c.id)
        continue
      }
      if (ALL_OPENS) {
        const projection = await TimelineProjection.open({
          store: timelineStoreFromRecords(data.timelineRecords!(c.tabId)),
          history: {
            lastSeq: c.lastSeq,
            async *pages(afterSeq) {
              for (let after = afterSeq; ; ) {
                const page = store.readPage(c.id, after, c.lastSeq + 1, BUDGET)
                if (page.events.length === 0) return
                yield page.events
                if (!page.more) return
                after = page.events[page.events.length - 1].seq
              }
            }
          },
          agentStartedTurns: chatCapabilitiesForMode(c.mode).agentStartedTurns
        })
        try {
          const window = await projection.openSnapshot('benchmark', { windowed: true })
          const wire = JSON.stringify(window)
          const page = window.summaries.length - 1
          const older =
            page < 0
              ? null
              : await projection.pagesAsOf(
                  [page],
                  window.seq,
                  window.epoch,
                  page * window.pageRows,
                  'benchmark',
                  { windowed: true }
                )
          appendFileSync(
            OUT,
            JSON.stringify({
              kind: 'open',
              openBytes: Buffer.byteLength(wire),
              deflateBytes: deflateRawSync(wire, { level: 3, memLevel: 6 }).length,
              olderPageBytes: older ? Buffer.byteLength(JSON.stringify(older)) : null
            }) + '\n'
          )
        } finally {
          await projection.close()
        }
        continue
      }
      // 1. Cold hydrate: every saved event, a page at a time (as `ChatEventLog.pages`).
      const events: Stored[] = []
      let t = performance.now()
      for (let after = -1; ; ) {
        const page = store.readPage(c.id, after, Number.MAX_SAFE_INTEGER, BUDGET)
        for (const e of page.events) events.push({ seq: e.seq, event: e.event, at: e.at })
        if (page.events.length === 0 || !page.more) break
        after = page.events[page.events.length - 1].seq
      }
      const hydrateReadMs = performance.now() - t
      const lastSeq = events.at(-1)?.seq ?? -1
      const history: TimelineHistorySource = {
        lastSeq,
        async *pages(afterSeq) {
          for (let i = 0; i < events.length; i += 2000) {
            const page = events.slice(i, i + 2000).filter((e) => e.seq > afterSeq)
            if (page.length) yield page
          }
        }
      }
      const agentStartedTurns = chatCapabilitiesForMode(c.mode).agentStartedTurns

      // 2. Projection rebuild (no stored projection), in memory.
      t = performance.now()
      const rebuilt = await TimelineProjection.open({
        store: memoryStore(),
        history,
        agentStartedTurns
      })
      const rebuildMs = performance.now() - t

      // 3. Projection restore from the store's own checkpoint (rebuilds if none fits).
      const hasCheckpoint = (await data.loadTimelineCheckpoint(c.tabId)) != null
      let restoreSaves = 0
      t = performance.now()
      const restored = await TimelineProjection.open({
        store: {
          loadCheckpoint: () => data.loadTimelineCheckpoint(c.tabId),
          loadPages: (pages) => data.loadTimelinePages(c.tabId, [...pages]),
          loadSummaries: () => data.loadTimelineSummaries(c.tabId),
          save: (write) => {
            restoreSaves++
            return data.saveTimeline(c.tabId, write)
          },
          searchPages: (needle) => data.searchTimelinePages(c.tabId, needle),
          discard: () => data.clearTimeline(c.tabId)
        },
        history,
        agentStartedTurns
      })
      const restoreMs = performance.now() - t
      await rebuilt.close()

      // 4. Desktop open: the snapshot, as sent, and the client's decode.
      t = performance.now()
      const snapshot = await restored.openSnapshot()
      const snapshotMs = performance.now() - t
      const wire = JSON.stringify(snapshot)
      t = performance.now()
      const preview = await restored.openSnapshot('benchmark')
      const previewSnapshotMs = performance.now() - t
      const previewWire = JSON.stringify(preview)
      t = performance.now()
      const decoded = decodeTimelineState(snapshot.state)
      const decodeMs = performance.now() - t
      const tailRows = decoded.timeline.filter((r) => r !== undefined).length
      t = performance.now()
      decodeTimelineState(preview.state)
      const previewDecodeMs = performance.now() - t
      t = performance.now()
      const wsBytes = deflateRawSync(previewWire, { level: 3, memLevel: 6 }).length
      const deflateMs = performance.now() - t
      t = performance.now()
      const window = await restored.openSnapshot('benchmark', { windowed: true })
      const windowWire = JSON.stringify(window)
      const windowSnapshotMs = performance.now() - t
      t = performance.now()
      const windowState = decodeTimelineState(window.state)
      const windowDecodeMs = performance.now() - t
      t = performance.now()
      const windowWsBytes = deflateRawSync(windowWire, { level: 3, memLevel: 6 }).length
      const windowDeflateMs = performance.now() - t
      const windowPage = window.summaries.length - 1
      const olderWindow =
        windowPage >= 0
          ? await restored.pagesAsOf(
              [windowPage],
              window.seq,
              window.epoch,
              windowPage * window.pageRows,
              'benchmark',
              { windowed: true }
            )
          : null
      const windowPageWire = olderWindow ? JSON.stringify(olderWindow) : ''
      const windowRows = windowState.timeline.filter((row) => row !== undefined)

      // 5. One older page (the newest sealed one), as scrolling up asks for it.
      let pageMs = 0,
        pageBytes = 0,
        previewPageBytes = 0,
        previewPageDeflateBytes = 0
      const sealed = snapshot.summaries.length
      if (sealed > 0) {
        const p = sealed - 1
        t = performance.now()
        const res = await restored.pagesAsOf(
          [p],
          snapshot.seq,
          snapshot.epoch,
          p * snapshot.pageRows
        )
        pageMs = performance.now() - t
        pageBytes = Buffer.byteLength(JSON.stringify(res))
        const compactPage = await restored.pagesAsOf(
          [p],
          preview.seq,
          preview.epoch,
          p * preview.pageRows,
          'benchmark'
        )
        const pageWire = JSON.stringify(compactPage)
        previewPageBytes = Buffer.byteLength(pageWire)
        previewPageDeflateBytes = deflateRawSync(pageWire, { level: 3, memLevel: 6 }).length
      }
      await restored.close()

      // 6. Mobile open: the whole replay, shipped and reduced as one batch.
      const replayWire = JSON.stringify(events)
      t = performance.now()
      reducer(initialState({ agentStartedTurns }), {
        type: 'events',
        events: events.map((e) => e.event),
        at: events.map((e) => e.at),
        seq: events.map((e) => e.seq)
      })
      const mobileReduceMs = performance.now() - t

      const row = {
        kind: 'conversation',
        id: c.id.slice(0, 8),
        mode: c.mode,
        events: c.n,
        storedKB: kb(c.bytes),
        hydrateReadMs: ms(hydrateReadMs),
        projectionRebuildMs: ms(rebuildMs),
        projectionRestoreMs: ms(restoreMs),
        hadCheckpoint: hasCheckpoint,
        restoreSaves,
        snapshotMs: ms(snapshotMs),
        snapshotKB: kb(Buffer.byteLength(wire)),
        previewSnapshotKB: kb(Buffer.byteLength(previewWire)),
        previewSnapshotMs: ms(previewSnapshotMs),
        previewDecodeMs: ms(previewDecodeMs),
        previewWebSocketKB: kb(wsBytes),
        previewDeflateMs: ms(deflateMs),
        windowSnapshotKB: kb(Buffer.byteLength(windowWire)),
        windowWebSocketKB: kb(windowWsBytes),
        windowWsBytes,
        windowSnapshotMs: ms(windowSnapshotMs),
        windowDecodeMs: ms(windowDecodeMs),
        windowDeflateMs: ms(windowDeflateMs),
        windowPageKB: kb(Buffer.byteLength(windowPageWire)),
        windowPageWebSocketKB: kb(deflateRawSync(windowPageWire, { level: 3, memLevel: 6 }).length),
        windowRows: windowRows.length,
        windowTopRowKB: kb(
          Math.max(0, ...windowRows.map((row) => Buffer.byteLength(JSON.stringify(row))))
        ),
        windowIndexesKB: kb(Buffer.byteLength(JSON.stringify(JSON.parse(window.state).state))),
        windowSummariesKB: kb(Buffer.byteLength(JSON.stringify(window.summaries))),
        snapshotGzipKB: kb(gzipSync(wire).length),
        snapshotStateKB: kb(Buffer.byteLength(snapshot.state)),
        summaries: sealed,
        tailRows,
        clientDecodeMs: ms(decodeMs),
        olderPageMs: ms(pageMs),
        olderPageKB: kb(pageBytes),
        olderPreviewPageKB: kb(previewPageBytes),
        olderPreviewPageWebSocketKB: kb(previewPageDeflateBytes),
        mobileReplayKB: kb(Buffer.byteLength(replayWire)),
        mobileReplayGzipKB: kb(gzipSync(replayWire).length),
        mobileReduceMs: ms(mobileReduceMs)
      }
      console.log('[open-perf]', JSON.stringify(row))
      appendFileSync(OUT, JSON.stringify(row) + '\n')
    }
    store.close()
    expect(true).toBe(true)
  },
  3_600_000
)
