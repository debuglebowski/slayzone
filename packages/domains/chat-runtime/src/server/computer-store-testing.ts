import { z } from 'zod'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import type { ChatStoreServices } from './computer-chat-stores'
import type { ChatStoreJobs } from './computer-chat-store-jobs'
import { chatTestRequestSchema } from './computer-testing-schema'
/** Deliberately narrow fault injection; never expose arbitrary computer SQL. */
export async function handleStoreTesting(
  r: ChatStoreServices & ChatStoreJobs,
  host: { busy(tabId: string): Promise<boolean>; remove(tabId: string): Promise<void> },
  req: z.infer<typeof chatTestRequestSchema>
) {
  if (process.env.PLAYWRIGHT !== '1') throw new Error('test-only handler unavailable')
  if (Buffer.byteLength(JSON.stringify(req)) > 8 * 1024 * 1024)
    throw new Error('Test batch exceeds byte limit')
  if (req.kind === 'test.watchdog') throw new Error('Watchdog belongs to the host controller')
  const { id, epoch } = req.route,
    owner = r.storage.conversation(id)
  if (!owner || owner.identity.epoch !== epoch || owner.state !== 'active')
    throw new Error('Test storage ownership mismatch')
  if (r.storage.taskLifecycle(owner.identity.taskId).state !== 'active')
    throw new Error('Task chat is paused or deleted')
  return r.retention.access(id, async () => {
    if (req.kind === 'test.readEvents')
      return r.storage.compose((db) => {
        const result: Array<{ seq: number; event: AgentEvent }> = []
        let bytes = 0
        for (const row of db
          .prepare(
            'SELECT seq,event FROM events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?'
          )
          .iterate(id, req.afterSeq, req.limit) as Iterable<{ seq: number; event: string }>) {
          bytes += Buffer.byteLength(row.event)
          if (bytes > 8 * 1024 * 1024) {
            if (!result.length) throw new Error('Test event exceeds byte limit')
            break
          }
          result.push({ seq: row.seq, event: JSON.parse(row.event) as AgentEvent })
        }
        return result
      })
    if (req.kind === 'test.seedPrompts') {
      r.storage.transaction(() => {
        for (const prompt of req.prompts)
          r.storage.putRecord(id, epoch, {
            kind: 'prompt',
            id: prompt.id,
            value: { ...prompt, taskId: owner.identity.taskId },
            at: prompt.createdAt
          })
      })
      return { ok: true }
    }
    if (req.kind === 'test.storageSlack') {
      // Free pages for the storage-compaction e2e: about `megabytes` of filler rows
      // saved, then deleted (no live chat); then the image backfill run to its end, as
      // a rebuild waits for it.
      if (await host.busy(owner.identity.tabId)) throw new Error('Cannot seed a live chat')
      const from = r.storage.nextSeq(id),
        rows = req.megabytes * 10,
        filler = 'f'.repeat(100_000)
      // 10 MB per transaction, the event loop runs between them.
      for (let start = 0; start < rows; start += 100) {
        r.storage.transaction(() => {
          for (let i = start; i < Math.min(rows, start + 100); i++)
            r.storage.appendAt(
              id,
              epoch,
              from + i,
              { kind: 'assistant-text', messageId: `slack-${i}`, text: filler },
              Date.now()
            )
        })
        await new Promise((resolve) => setImmediate(resolve))
      }
      for (let start = 0; start < rows; start += 100) {
        r.storage.compose((db) =>
          db
            .prepare('DELETE FROM events WHERE conversation_id=? AND seq>=? AND seq<?')
            .run(id, from + start, from + start + 100)
        )
        await new Promise((resolve) => setImmediate(resolve))
      }
      await r.blobBackfill.runNow()
      // The e2e compares physical file sizes; NORMAL commits may still be in the WAL.
      await r.storage.maintenance.checkpointNow()
      return r.compaction.status()
    }
    if (req.kind === 'test.seedEvents') {
      if (await host.busy(owner.identity.tabId)) throw new Error('Cannot seed a live chat')
      await host.remove(owner.identity.tabId)
      r.storage.transaction(() => {
        for (const [index, event] of req.events.entries()) {
          const seq = req.fromSeq + index
          if (!Number.isSafeInteger(seq)) throw new Error('Invalid test event sequence')
          // Raw, as an agent produced it: stored the way every saved event is.
          const stored = r.storage.extractEventBlobs(event as AgentEvent)
          if (
            r.storage.appendAt(id, epoch, seq, stored, Date.now()) === 'clash' &&
            JSON.stringify(r.storage.read(id, seq - 1, seq + 1)[0]?.event) !==
              JSON.stringify(stored)
          )
            throw new Error('Test event sequence conflict')
        }
      })
      return { ok: true }
    }
    if (req.action === 'corrupt-checkpoint') {
      if (await host.busy(owner.identity.tabId)) throw new Error('Cannot unload a live chat')
      await host.remove(owner.identity.tabId)
    }
    const checkpoint = r.storage.getRecord<{ version: string; seq: number; data: string }>(
      id,
      'timeline',
      'checkpoint'
    )
    if (req.action === 'corrupt-checkpoint' && checkpoint)
      r.storage.putRecord(id, epoch, {
        kind: 'timeline',
        id: 'checkpoint',
        value: { ...checkpoint, data: '{oops' },
        at: Date.now()
      })
    if (req.action === 'corrupt-page') {
      const page = r.storage.getRecord<Record<string, unknown>>(id, 'timeline', 'page:0')
      if (!page) throw new Error('Test page is missing')
      r.storage.putRecord(id, epoch, {
        kind: 'timeline',
        id: 'page:0',
        value: { ...page, rows: '{oops' },
        at: Date.now()
      })
    }
    return { checkpoint, lastSeq: r.storage.nextSeq(id) - 1 }
  })
}
