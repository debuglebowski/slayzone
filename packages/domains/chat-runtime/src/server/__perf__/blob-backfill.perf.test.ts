/**
 * Measurement (not a pass/fail gate): the event-blob backfill's effect on the
 * computer's event loop, and how often it reads each row (crash-fix 4 review-2 L1:
 * slices read 16 whole rows, used 1–2 large ones and read the rest again — event-loop
 * lag max 133 ms on 4,000 real rows of the largest dev chat).
 *
 * Fixture shaped like that chat: 4,000 legacy rows; 401 tool results with two
 * screenshots (~196 KB each, inline in `rawContent` and `structured`), the rest text
 * output (90 % 1 KiB, 9 % 20 KiB, 1 % 400 KiB). Real timer, default slice settings.
 * Or real rows (SLZ_PERF_SOURCE: a `seq<TAB>event` dump of saved events, exported
 * read-only; SLZ_PERF_BLOBS: their store's `blobs/` dir, read only): stored-form rows
 * are resolved back to the inline legacy form first.
 * Machine-dependent: run by hand
 *   npx vitest run --maxWorkers=3 --config packages/shared/test-utils/vitest.harness.config.ts \
 *     packages/domains/chat-runtime/src/server/__perf__/blob-backfill.perf.test.ts
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { afterAll, expect, test } from 'vitest'
import { resolveChatBlobs, type AgentEvent } from '@slayzone/terminal-contracts'
import { openChatStorage } from '../storage'
import { createChatBlobBackfill } from '../chat-blob-backfill'

const ROWS = Number(process.env.SLZ_PERF_ROWS ?? 4000)
const IMAGE_EVERY = 10

const root = mkdtempSync(join(tmpdir(), 'slz-backfill-perf-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function png(seed: number): Buffer {
  const b = Buffer.alloc(196 * 1024)
  for (let i = 0; i < b.length; i += 4) b.writeUInt32LE((seed * 2654435761 + i) >>> 0, i)
  return b
}
function textSize(i: number): number {
  const r = (i * 2654435761) % 1000
  return r < 900 ? 1024 : r < 990 ? 20 * 1024 : 400 * 1024
}
function row(i: number): AgentEvent {
  if (i % IMAGE_EVERY === 0) {
    const data = png(i).toString('base64')
    return {
      kind: 'tool-result',
      toolUseId: `t${i}`,
      isError: false,
      rawContent: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: png(i + 1).toString('base64') }
        }
      ],
      structured: { type: 'image', file: { base64: data, type: 'image/png' } }
    } as AgentEvent
  }
  return { kind: 'stderr', text: `${i}:${'y'.repeat(textSize(i))}` } as AgentEvent
}

test('backfill of a large legacy chat: event-loop lag and reads per row', async () => {
  const store = openChatStorage({ stateDir: root, hubScope: 'perf' })
  store.createConversation({ id: 'c', taskId: 't', tabId: 'tab', mode: 'claude-chat', epoch: 1 })
  const source = process.env.SLZ_PERF_SOURCE
  const blobDir = process.env.SLZ_PERF_BLOBS
  const rows: string[] = source
    ? readFileSync(source, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const stored = JSON.parse(line.slice(line.indexOf('\t') + 1)) as AgentEvent
          return JSON.stringify(
            resolveChatBlobs(stored, (ref) =>
              readFileSync(join(blobDir!, ref.sha256)).toString('base64')
            )
          )
        })
    : Array.from({ length: ROWS }, (_, i) => JSON.stringify(row(i)))
  store.compose((db) => {
    const insert = db.prepare(
      'INSERT INTO events(conversation_id,seq,saved_at,event) VALUES(?,?,?,?)'
    )
    db.transaction(() => {
      rows.forEach((event, i) => insert.run('c', i, 1_000 + i, event))
    })()
  })
  // Body reads by seq, whatever store read returns them.
  const reads: number[] = []
  const s = store as unknown as Record<string, unknown>
  for (const name of ['legacyEvents', 'legacyEvent']) {
    const original = s[name]
    if (typeof original !== 'function') continue
    s[name] = (...args: unknown[]) => {
      const got = (original as (...a: unknown[]) => unknown).apply(store, args)
      for (const r of (Array.isArray(got) ? got : got ? [got] : []) as Array<{ seq: number }>)
        reads.push(r.seq)
      return got
    }
  }
  const b = createChatBlobBackfill({
    storage: store,
    automatic: false,
    withQuiesced: async () => false,
    pruning: () => false,
    changed: () => undefined,
    log: () => undefined,
    freeBytes: () => Number.MAX_SAFE_INTEGER
  })

  await new Promise((r) => setTimeout(r, 500))
  const delay = monitorEventLoopDelay({ resolution: 5 })
  let maxCpu = 0,
    lastCpu = process.threadCpuUsage(),
    stop = false
  const probe = () => {
    const cpu = process.threadCpuUsage()
    maxCpu = Math.max(maxCpu, (cpu.user + cpu.system - lastCpu.user - lastCpu.system) / 1000)
    lastCpu = cpu
    if (!stop) setImmediate(probe)
  }
  setImmediate(probe)
  delay.enable()
  const start = performance.now()
  const report = await b.runNow()
  const wall = performance.now() - start
  await new Promise<void>((r) => setImmediate(r))
  stop = true
  delay.disable()
  const distinct = new Set(reads).size
  console.log(
    `[backfill-perf] ${source ? 'real' : 'synthetic'} rows=${rows.length} rewritten=${report?.rows} blobs=${report?.blobs} ` +
      `moved=${((report?.bytes ?? 0) / 1048576).toFixed(1)}MiB wall=${(wall / 1000).toFixed(1)}s | ` +
      `lag max=${(delay.max / 1e6).toFixed(0)}ms p99=${(delay.percentile(99) / 1e6).toFixed(0)}ms ` +
      `p50=${(delay.percentile(50) / 1e6).toFixed(1)}ms maxIterationCpu=${maxCpu.toFixed(0)}ms | ` +
      `body reads=${reads.length} (distinct rows ${distinct})`
  )
  if (!source) expect(report?.rows).toBe(Math.ceil(ROWS / IMAGE_EVERY))
  await b.close()
  store.close()
}, 1_800_000)
