/**
 * Event-blob backfill (crash fix 4): rows saved before v13 hold base64 inline. The
 * backfill moves those bytes out-of-line IN PLACE — representation, never meaning —
 * in small checkpointed slices, never inside a backup, never on a deleted chat.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { isChatBlobRef, resolveChatBlobs, type AgentEvent } from '@slayzone/terminal-contracts'
import { createComputerChatRuntime } from './computer-runtime'
import { createChatBlobBackfill, type ChatBlobBackfillOptions } from './chat-blob-backfill'
import { createChatRetention } from './retention'
import { TIMELINE_DROP_STEP_BYTES } from './storage'
// Fails the test on a lifecycle model / runtime disagreement.
import '../../../terminal/src/server/runtime/chat-lifecycle-strict-testkit'

const roots: string[] = []
const closers: Array<() => unknown> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function runtime(root = mkdtempSync(join(tmpdir(), 'slz-blob-backfill-'))) {
  if (!roots.includes(root)) roots.push(root)
  const r = createComputerChatRuntime({
    stateDir: root,
    hubScope: 'hub-a',
    computerId: 'pc',
    blobBackfill: { automatic: false }
  })
  closers.push(() => r.close())
  for (const taskId of ['task-a', 'task-b'])
    r.bootstrap({
      identity: { id: taskId, taskId, tabId: `tab-${taskId}`, mode: 'claude-chat', epoch: 1 },
      projectId: null,
      cwd: root,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
  return { r, root }
}
type Runtime = ReturnType<typeof runtime>['r']

const png = (seed: number, size = 4096) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size, seed)
  ])
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const screenshot = (bytes: Buffer): AgentEvent => ({
  kind: 'tool-result',
  toolUseId: 'tool-1',
  isError: false,
  rawContent: [
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') }
    }
  ],
  structured: { type: 'image', file: { base64: bytes.toString('base64'), type: 'image/png' } }
})
const text = (t: string): AgentEvent => ({ kind: 'assistant-text', messageId: t, text: t })

/** A row as a pre-v13 build saved it: raw content, form 0. */
function legacy(r: Runtime, id: string, seq: number, event: AgentEvent, at = 1000 + seq) {
  r.storage.compose((db) =>
    db
      .prepare('INSERT INTO events(conversation_id,seq,saved_at,event) VALUES(?,?,?,?)')
      .run(id, seq, at, JSON.stringify(event))
  )
}
const forms = (r: Runtime, id: string) =>
  r.storage.compose((db) =>
    (
      db
        .prepare('SELECT blob_form FROM events WHERE conversation_id=? ORDER BY seq')
        .all(id) as Array<{
        blob_form: number
      }>
    ).map((row) => row.blob_form)
  )
const resolved = (r: Runtime, id: string) =>
  r.storage
    .read(id, -1)
    .map((e) =>
      resolveChatBlobs(e.event, (ref) =>
        Buffer.from(r.storage.blobs.readBlob(ref.sha256)).toString('base64')
      )
    )

/**
 * The chat-session guard the runtime gives the backfill: retention's own lock + quiesce
 * mechanism (`withQuiesced`), here with an injectable busy / quiesce.
 */
function guard(
  r: Runtime,
  g: { busy?: () => boolean; quiesce?: (tabId: string) => Promise<void> } = {}
) {
  const retention = createChatRetention({
    automatic: false,
    storage: r.storage,
    local: r.local,
    busy: () => g.busy?.() ?? false,
    quiesce: async (tabId) => {
      await g.quiesce?.(tabId)
    },
    collectGarbage: () => undefined,
    changed: () => undefined
  })
  closers.push(() => retention.close())
  return retention.withQuiesced
}

function backfill(
  r: Runtime,
  opts: Partial<ChatBlobBackfillOptions> = {},
  g: Parameters<typeof guard>[1] = {}
) {
  const lines: string[] = []
  const changed = vi.fn()
  const b = createChatBlobBackfill({
    storage: r.storage,
    automatic: false,
    withQuiesced: guard(r, g),
    pruning: () => false,
    changed,
    log: (line) => lines.push(line),
    sleep: async () => undefined,
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    ...opts
  })
  closers.push(() => b.close())
  return { b, lines, changed }
}

test('rewrites legacy rows in place: bytes out-of-line, meaning unchanged, pinned at the row’s time', async () => {
  const { r } = runtime()
  const a = png(1),
    b = png(2)
  const original = [text('before'), screenshot(a), text('between'), screenshot(b), screenshot(a)]
  original.forEach((e, seq) => legacy(r, 'task-a', seq, e))
  const { b: run, lines } = backfill(r)
  const report = await run.runNow()
  expect(report).toMatchObject({ rows: 3, blobs: 6, faults: 0 })
  expect(report!.bytes).toBe(a.length * 4 + b.length * 2)
  expect(forms(r, 'task-a')).toEqual([0, 1, 0, 1, 1])
  const stored = r.storage.read('task-a', -1)
  expect(
    isChatBlobRef(
      (stored[1].event as { rawContent: Array<{ source: { data: unknown } }> }).rawContent[0].source
        .data
    )
  ).toBe(true)
  expect(resolved(r, 'task-a')).toEqual(original)
  expect(
    Object.fromEntries(r.storage.records('task-a', 'event-blob').map((p) => [p.id, p.at]))
  ).toEqual({
    [sha(a)]: 1004,
    [sha(b)]: 1003
  })
  expect(run.done()).toBe(true)
  // Progress + completion are logged — counts only, never chat content.
  expect(lines.some((l) => /complete/i.test(l))).toBe(true)
  for (const line of lines) {
    expect(line).not.toContain(a.toString('base64').slice(0, 32))
    expect(line).not.toMatch(/before|between/)
  }
})

test('a second run does nothing; rows saved in stored form are never touched', async () => {
  const { r } = runtime()
  legacy(r, 'task-a', 0, screenshot(png(3)))
  await backfill(r).b.runNow()
  // New rows (stored form), one holding a reference-shaped object a tool printed.
  r.storage.append('task-a', 1, {
    kind: 'tool-result',
    toolUseId: 't',
    isError: false,
    rawContent: [{ $chatBlob: { v: 1, sha256: 'e'.repeat(64), mediaType: 'image/png', size: 1 } }],
    structured: null
  } as AgentEvent)
  const before = r.storage.read('task-a', -1)
  const again = backfill(r).b
  expect(await again.runNow()).toBeNull()
  expect(r.storage.read('task-a', -1)).toEqual(before)
})

test('works in bounded slices, yields between them, and resumes from its checkpoint after a restart', async () => {
  const { r, root } = runtime()
  const images = Array.from({ length: 12 }, (_, i) => png(10 + i, 64 * 1024))
  images.forEach((img, seq) => legacy(r, 'task-a', seq, screenshot(img)))
  let slices = 0
  const stop = createChatBlobBackfill({
    storage: r.storage,
    automatic: false,
    withQuiesced: guard(r),
    pruning: () => false,
    changed: () => undefined,
    log: () => undefined,
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    sliceBytes: 200 * 1024,
    sleep: async () => {
      slices++
      // Each slice moved at most what fits its byte budget (one row may exceed it).
      expect(forms(r, 'task-a').filter((f) => f === 1).length).toBeLessThanOrEqual(slices * 2)
      // Stopped from inside a pause (as `close()` on shutdown): it must not wait on itself.
      if (slices === 3) void stop.close()
    }
  })
  await stop.runNow()
  const firstRun = forms(r, 'task-a').filter((f) => f === 1).length
  expect(firstRun).toBeGreaterThan(0)
  expect(firstRun).toBeLessThan(images.length)
  await r.close()
  // Restart: a new runtime and backfill continue where the checkpoint is.
  const next = createComputerChatRuntime({
    stateDir: root,
    hubScope: 'hub-a',
    computerId: 'pc',
    blobBackfill: { automatic: false }
  })
  closers.push(() => next.close())
  const report = await backfill(next).b.runNow()
  expect(report!.rows).toBe(images.length - firstRun)
  expect(forms(next, 'task-a').every((f) => f === 1)).toBe(true)
  expect(resolved(next, 'task-a')).toEqual(images.map(screenshot))
})

test('events appended while it runs are kept and stay in stored form', async () => {
  const { r } = runtime()
  for (let seq = 0; seq < 6; seq++) legacy(r, 'task-a', seq, screenshot(png(30 + seq, 64 * 1024)))
  const fresh = png(40)
  let appended = false
  const { b } = backfill(r, {
    sliceBytes: 64 * 1024,
    sleep: async () => {
      if (!appended) {
        appended = true
        r.storage.append('task-a', 1, screenshot(fresh), 5000)
      }
    }
  })
  await b.runNow()
  expect(forms(r, 'task-a')).toEqual([1, 1, 1, 1, 1, 1, 1])
  expect(resolved(r, 'task-a').at(-1)).toEqual(screenshot(fresh))
})

test('never runs while a backup holds its blob lease; a backup taken mid-run is complete and verifiable', async () => {
  const { r } = runtime()
  for (let seq = 0; seq < 6; seq++) legacy(r, 'task-a', seq, screenshot(png(50 + seq, 64 * 1024)))
  let lease: { release(): void } | null = r.storage.acquireBlobLease('backup-test', 60_000)
  let waits = 0,
    backupId: string | null = null
  const { b } = backfill(r, {
    sliceBytes: 64 * 1024,
    sleep: async () => {
      waits++
      if (lease) {
        // Held: nothing may have been rewritten yet.
        expect(forms(r, 'task-a').every((f) => f === 0)).toBe(true)
        if (waits === 3) {
          lease.release()
          lease = null
        }
      } else if (!backupId) backupId = (await r.backups.create('manual')).id
    }
  })
  await b.runNow()
  expect(forms(r, 'task-a').every((f) => f === 1)).toBe(true)
  // The mid-run backup restores, and every row it holds reads back to the original.
  const archive = await r.backups.restore(backupId!)
  const archived = (await r.backups.read(archive.id, 'task-a', -1, 100)).events
  expect(archived).toHaveLength(6)
  for (const e of archived) {
    const hashes = new Set<string>()
    JSON.stringify(e.event, (_key, value) => {
      if (isChatBlobRef(value)) hashes.add(value.$chatBlob.sha256)
      return value
    })
    const blobs = new Map<string, string>()
    for (const hash of hashes) {
      const chunks: Buffer[] = []
      let offset = 0
      for (;;) {
        const chunk = await r.backups.blob(archive.id, 'task-a', hash, offset)
        const bytes = Buffer.from(chunk.data, 'base64')
        chunks.push(bytes)
        offset += bytes.length
        if (offset >= chunk.size) break
      }
      blobs.set(hash, Buffer.concat(chunks).toString('base64'))
    }
    expect(resolveChatBlobs(e.event, (ref) => blobs.get(ref.sha256)!)).toEqual(
      screenshot(png(50 + e.seq, 64 * 1024))
    )
  }
})

test('a task erased mid-run leaves no images behind; the other task completes', async () => {
  const { r } = runtime()
  const mine = Array.from({ length: 4 }, (_, i) => png(60 + i, 64 * 1024))
  const theirs = png(70)
  mine.forEach((img, seq) => legacy(r, 'task-a', seq, screenshot(img)))
  legacy(r, 'task-b', 0, screenshot(theirs))
  let erased = false
  const { b } = backfill(r, {
    sliceBytes: 64 * 1024,
    sleep: async () => {
      if (!erased && forms(r, 'task-a').includes(1)) {
        erased = true
        await r.applyTaskLifecycle('task-a', 'deleted', 2)
        await r.eraseTask('task-a', 2)
      }
    }
  })
  await b.runNow()
  expect(erased).toBe(true)
  r.attachments.collectGarbage()
  for (const img of mine) expect(existsSync(join(r.storage.dir, 'blobs', sha(img)))).toBe(false)
  expect(existsSync(join(r.storage.dir, 'blobs', sha(theirs)))).toBe(true)
  expect(forms(r, 'task-b')).toEqual([1])
})

test('a row whose round trip cannot be verified stays inline and is recorded as a fault', async () => {
  const { r } = runtime()
  const bad = png(80),
    good = png(81)
  legacy(r, 'task-a', 0, screenshot(bad))
  legacy(r, 'task-a', 1, screenshot(good))
  const read = r.storage.blobs.readBlob
  r.storage.blobs.readBlob = (hash: string) => {
    const bytes = Buffer.from(read(hash))
    if (hash === sha(bad)) bytes[bytes.length - 1] ^= 1
    return bytes
  }
  const report = await backfill(r).b.runNow()
  r.storage.blobs.readBlob = read
  expect(report).toMatchObject({ rows: 1, faults: 1 })
  expect(forms(r, 'task-a')).toEqual([0, 1])
  expect(resolved(r, 'task-a')).toEqual([screenshot(bad), screenshot(good)])
  const faults = r.storage.listFaults().filter((f) => f.pass === 'computer.chat-blob-backfill')
  expect(faults).toHaveLength(1)
  expect(faults[0].message).not.toContain(bad.toString('base64').slice(0, 32))
})

test('the timeline projection of a rewritten chat is reset once it is idle; a busy chat waits', async () => {
  const { r } = runtime()
  legacy(r, 'task-a', 0, screenshot(png(90)))
  const page = () =>
    r.storage.putRecord('task-a', 1, {
      kind: 'timeline',
      id: 'page:0',
      value: { rows: '[]' },
      at: 1
    })
  page()
  let busy = true
  const quiesce = vi.fn(async () => undefined)
  const { b, changed } = backfill(r, {}, { busy: () => busy, quiesce })
  await b.runNow()
  expect(forms(r, 'task-a')).toEqual([1])
  expect(r.storage.records('task-a', 'timeline')).toHaveLength(1)
  expect(b.done()).toBe(false)
  busy = false
  await b.runNow()
  expect(quiesce).toHaveBeenCalledWith('tab-task-a')
  expect(r.storage.records('task-a', 'timeline')).toEqual([])
  expect(changed).toHaveBeenCalledWith('tab-task-a')
  expect(b.done()).toBe(true)
})

test('skips a chat while retention prunes it, and finishes it afterwards', async () => {
  const { r } = runtime()
  legacy(r, 'task-a', 0, screenshot(png(95)))
  let pruning = true
  const { b } = backfill(r, {
    pruning: () => pruning,
    sleep: async () => {
      pruning = false
    }
  })
  await b.runNow()
  expect(forms(r, 'task-a')).toEqual([1])
})

test('close() mid-pass settles promptly with the REAL timer, and the runtime closes everything after it', async () => {
  const { r } = runtime()
  for (let seq = 0; seq < 6; seq++) legacy(r, 'task-a', seq, screenshot(png(100 + seq, 64 * 1024)))
  const { b } = backfill(r, { sleep: undefined, sliceBytes: 64 * 1024, idleMs: 60_000 })
  const run = b.runNow()
  await vi.waitFor(() => expect(forms(r, 'task-a')).toContain(1), { timeout: 5_000 })
  const started = Date.now()
  await b.close()
  await run
  expect(Date.now() - started).toBeLessThan(2_000)

  // The runtime's own backfill: its close must not stall the rest of runtime close.
  const other = runtime().r
  for (let seq = 0; seq < 6; seq++)
    legacy(other, 'task-a', seq, screenshot(png(110 + seq, 64 * 1024)))
  void other.blobBackfill.runNow()
  await vi.waitFor(() => expect(forms(other, 'task-a')).toContain(1), { timeout: 5_000 })
  const closing = Date.now()
  await other.close()
  expect(Date.now() - closing).toBeLessThan(3_000)
  expect(() => other.retention.configure(1)).toThrow(/closed/i)
  expect(() => other.storage.read('task-a', -1)).toThrow()
})

test('never quiesces a chat that became busy while the pass waited; resets it once it is idle', async () => {
  const { r } = runtime()
  legacy(r, 'task-a', 0, screenshot(png(120)))
  r.storage.putRecord('task-a', 1, { kind: 'timeline', id: 'page:0', value: { rows: '[]' }, at: 1 })
  let busy = false
  let lease: { release(): void } | null = r.storage.acquireBlobLease('backup', 60_000)
  const quiesce = vi.fn(async () => undefined)
  const { b } = backfill(
    r,
    {
      sleep: async () => {
        // During the backup's lease wait the user starts a turn.
        if (lease) {
          busy = true
          lease.release()
          lease = null
        }
      }
    },
    { busy: () => busy, quiesce }
  )
  await b.runNow()
  expect(forms(r, 'task-a')).toEqual([1])
  expect(quiesce).not.toHaveBeenCalled()
  expect(r.storage.records('task-a', 'timeline')).toHaveLength(1)
  expect(b.done()).toBe(false)
  busy = false
  await b.runNow()
  expect(quiesce).toHaveBeenCalledWith('tab-task-a')
  expect(r.storage.records('task-a', 'timeline')).toEqual([])
  expect(b.done()).toBe(true)
})

test('a chat skipped in one pass (frozen for a move) is converted in a later pass; done only then', async () => {
  const { r } = runtime()
  legacy(r, 'task-a', 0, screenshot(png(130)))
  legacy(r, 'task-b', 0, screenshot(png(131)))
  r.storage.freeze('task-a', 1, 'move-1')
  const { b } = backfill(r)
  await b.runNow()
  expect(forms(r, 'task-a')).toEqual([0])
  expect(forms(r, 'task-b')).toEqual([1])
  expect(b.done()).toBe(false)
  r.storage.unfreeze('task-a', 1, 'move-1')
  await b.runNow()
  expect(forms(r, 'task-a')).toEqual([1])
  expect(b.done()).toBe(true)
})

test('pauses (logged) while free disk space is under its margin, and resumes once there is room', async () => {
  const { r } = runtime()
  legacy(r, 'task-a', 0, screenshot(png(140)))
  let free = 100 * 1024 * 1024
  const { b, lines } = backfill(r, { freeBytes: () => free })
  await b.runNow()
  expect(forms(r, 'task-a')).toEqual([0])
  expect(b.done()).toBe(false)
  expect(lines.some((l) => /disk space/i.test(l))).toBe(true)
  free = 50 * 1024 * 1024 * 1024
  await b.runNow()
  expect(forms(r, 'task-a')).toEqual([1])
  expect(b.done()).toBe(true)
})

test('a fault records only its class, never text from the row', async () => {
  const { r } = runtime()
  const corrupt = `{"kind":"tool-result","rawContent":[{"type":"base64","media_type":"image/png","data":"${'A'.repeat(2000)}"}],"note":"SECRET-CHAT-TEXT`
  r.storage.compose((db) =>
    db
      .prepare('INSERT INTO events(conversation_id,seq,saved_at,event) VALUES(?,?,?,?)')
      .run('task-a', 0, 1, corrupt)
  )
  const report = await backfill(r).b.runNow()
  expect(report).toMatchObject({ faults: 1 })
  const [fault] = r.storage.listFaults().filter((f) => f.pass === 'computer.chat-blob-backfill')
  expect(fault.message).toMatch(/\(parse\)/)
  expect(fault.message).not.toContain('SECRET')
  expect(fault.message).not.toContain('AAAA')
})

test('pre-v13 timeline pages are left to the projection version (refused + rebuilt on open): they never block the pass', async () => {
  const { r, root } = runtime()
  r.storage.putRecord('task-b', 1, { kind: 'timeline', id: 'page:0', value: { rows: '[]' }, at: 1 })
  // As a v12 store: no blob_form column, user_version 12.
  r.storage.compose((db) => {
    db.exec('ALTER TABLE events DROP COLUMN blob_form')
    db.pragma('user_version = 12')
  })
  await r.close()
  const next = createComputerChatRuntime({
    stateDir: root,
    hubScope: 'hub-a',
    computerId: 'pc',
    blobBackfill: { automatic: false }
  })
  closers.push(() => next.close())
  const quiesce = vi.fn(async () => undefined)
  const { b } = backfill(next, {}, { quiesce })
  await b.runNow()
  // Nothing was rewritten there: no session is closed for it, and the pass is done.
  expect(quiesce).not.toHaveBeenCalled()
  expect(b.done()).toBe(true)
})

test('a rewritten chat of a PAUSED task does not block completion: its pages are reset', async () => {
  const { r } = runtime()
  legacy(r, 'task-a', 0, screenshot(png(150)))
  r.storage.putRecord('task-a', 1, { kind: 'timeline', id: 'page:0', value: { rows: '[]' }, at: 1 })
  await r.applyTaskLifecycle('task-a', 'paused', 2)
  const { b, lines } = backfill(r)
  await b.runNow()
  expect(forms(r, 'task-a')).toEqual([1])
  expect(r.storage.records('task-a', 'timeline')).toEqual([])
  expect(b.done()).toBe(true)
  expect(lines.some((l) => /complete/.test(l))).toBe(true)
})

test('an incomplete pass logs its pending timeline resets by count', async () => {
  const { r } = runtime()
  legacy(r, 'task-a', 0, screenshot(png(151)))
  r.storage.putRecord('task-a', 1, { kind: 'timeline', id: 'page:0', value: { rows: '[]' }, at: 1 })
  const { b, lines } = backfill(r, {}, { busy: () => true })
  await b.runNow()
  expect(b.done()).toBe(false)
  expect(lines.some((l) => /1 timeline reset pending/.test(l))).toBe(true)
})

test('timeline resets go in byte-bounded steps, the event loop running between steps and chats', async () => {
  // 2026-11-15 09:03: resetting 63 chats' pages (hundreds of MB, secure-delete) froze
  // the computer 12.7 s — an idle chat's quiesce resolves in microtasks, so the whole
  // loop ran in one turn.
  const { r } = runtime()
  const big = { rows: `["${'x'.repeat(TIMELINE_DROP_STEP_BYTES)}"]` }
  for (const id of ['task-a', 'task-b']) {
    legacy(r, id, 0, screenshot(png(id === 'task-a' ? 91 : 92)))
    for (const n of [0, 1])
      r.storage.putRecord(id, 1, { kind: 'timeline', id: `page:${n}`, value: big, at: 1 })
  }
  let ticks = 0,
    spinning = true
  const spin = () => {
    ticks++
    if (spinning) setImmediate(spin)
  }
  setImmediate(spin)
  const steps: number[] = []
  const step = r.storage.dropTimelineStep.bind(r.storage)
  vi.spyOn(r.storage, 'dropTimelineStep').mockImplementation((id, epoch, budget) => {
    steps.push(ticks)
    return step(id, epoch, budget)
  })
  const { b, changed } = backfill(r)
  await b.runNow()
  spinning = false
  expect(changed).toHaveBeenCalledTimes(2)
  expect(steps.length).toBeGreaterThanOrEqual(4)
  expect(new Set(steps).size).toBe(steps.length)
  for (const id of ['task-a', 'task-b']) expect(r.storage.hasTimeline(id)).toBe(false)
  expect(b.done()).toBe(true)
})

/**
 * Every legacy row body the pass reads, by seq (whatever store read returns bodies).
 * Review-2 L1: a slice read 16 whole rows, used 1–2 large ones and read the rest
 * again in the next slice (≈8× per large-row chat), and the read itself was unbounded.
 */
function bodyReads(r: Runtime): number[] {
  const seen: number[] = []
  const store = r.storage as unknown as Record<string, unknown>
  for (const name of ['legacyEvents', 'legacyEvent'] as const) {
    const original = store[name]
    if (typeof original !== 'function') continue
    store[name] = (...args: unknown[]) => {
      const got = (original as (...a: unknown[]) => unknown).apply(r.storage, args)
      const rows = Array.isArray(got) ? got : got ? [got] : []
      for (const row of rows as Array<{ seq: number }>) seen.push(row.seq)
      return got
    }
  }
  return seen
}

test('reads each legacy row once, never one it cannot use, and no slice reads past its byte budget', async () => {
  const { r } = runtime()
  // Large rows between small ones (a short text never holds a blob slot).
  let seq = 0
  const large: number[] = [],
    small: number[] = []
  for (let i = 0; i < 12; i++) {
    large.push(seq)
    legacy(r, 'task-a', seq++, screenshot(png(40 + i, 96 * 1024)))
    for (let k = 0; k < 3; k++) {
      small.push(seq)
      legacy(r, 'task-a', seq++, text(`short ${i}.${k}`))
    }
  }
  const reads = bodyReads(r)
  const sliceBytes = 300 * 1024
  const perSlice: number[][] = [[]]
  let counted = 0
  const { b } = backfill(r, {
    sliceBytes,
    sleep: async () => {
      perSlice[perSlice.length - 1].push(...reads.slice(counted))
      counted = reads.length
      perSlice.push([])
    }
  })
  await b.runNow()
  perSlice[perSlice.length - 1].push(...reads.slice(counted))
  expect(forms(r, 'task-a').filter((_, s) => large.includes(s))).toEqual(large.map(() => 1))
  // Once each, and never a row too short to hold a blob.
  expect([...reads].sort((a, c) => a - c)).toEqual(large)
  // A slice reads one row, or rows within its budget (sizes as stored).
  const size = (s: number) =>
    r.storage.compose(
      (db) =>
        (
          db
            .prepare(
              'SELECT octet_length(event) AS n FROM events WHERE conversation_id=? AND seq=?'
            )
            .get('task-a', s) as { n: number }
        ).n
    )
  expect(perSlice.filter((s) => s.length > 0).length).toBeGreaterThan(1)
  for (const slice of perSlice)
    if (slice.length > 1)
      expect(slice.reduce((n, s) => n + size(s), 0)).toBeLessThanOrEqual(sliceBytes)
})
