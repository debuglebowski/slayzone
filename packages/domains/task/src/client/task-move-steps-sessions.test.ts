import { describe, expect, test } from 'vitest'
import type { TaskMove, TaskMoveChatTransfer } from '@slayzone/task-contracts'
import {
  createTaskMoveSteps,
  type TaskMoveSourceApi,
  type TaskMoveTargetApi
} from './task-move-steps'

const move = (over: Partial<TaskMove> = {}): TaskMove => ({
  id: 'm1',
  direction: 'out',
  peerHubId: 'hub-b',
  targetProjectId: 'p',
  rootTaskIds: ['t1'],
  taskIds: ['t1'],
  includeSubtasks: true,
  includeSessions: true,
  step: 'copy-sessions',
  status: 'running',
  error: null,
  progress: null,
  createdAt: 0,
  updatedAt: 0,
  ...over
})

const manifest = (id: string, bytes: number, epoch = 3): TaskMoveChatTransfer['manifest'] => ({
  header: {
    migrationId: 'move:m1',
    identity: { id, taskId: 't1', tabId: `tab-${id}`, mode: 'claude-chat', epoch }
  },
  hash: 'a'.repeat(64),
  bytes
})

/** The app between two fakes: what the source exports, what the target was told. */
function harness(opts: { transfers: TaskMoveChatTransfer[]; resumeAt?: number; missing?: number }) {
  const calls: string[] = []
  const written = new Map<string, Buffer[]>()
  const payload = new Map(
    opts.transfers.map((t) => [
      t.manifest.header.identity.id,
      Buffer.alloc(t.manifest.bytes, t.manifest.header.identity.id.charCodeAt(0))
    ])
  )
  const source: Pick<
    TaskMoveSourceApi,
    'sessionsExport' | 'sessionsRead' | 'sessionsReadAttachment' | 'sessionsDiscard'
  > = {
    sessionsExport: async (_m, taskId) => {
      calls.push(`export ${taskId}`)
      return { transfers: opts.transfers, ledger: { rows: taskId } }
    },
    sessionsRead: async (i) => {
      calls.push(`read ${i.conversationId}@${i.offset}`)
      return payload
        .get(i.conversationId)!
        .subarray(i.offset, i.offset + i.length)
        .toString('base64')
    },
    sessionsReadAttachment: async (i) => {
      calls.push(`attachment ${i.ref.artifactId} epoch ${i.epoch}`)
      return Buffer.from('file').toString('base64')
    },
    sessionsDiscard: async () => {
      calls.push('discard')
    }
  }
  const target: Omit<
    TaskMoveTargetApi,
    'importBundle' | 'addRemoteBlockers' | 'missingFiles' | 'writeFile' | 'clearStaging' | 'commit'
  > = {
    sessionsBegin: async (_m, _t, m) => {
      calls.push(`begin ${m.header.identity.id}`)
      return { transferId: `x-${m.header.identity.id}`, offset: opts.resumeAt ?? 0 }
    },
    sessionsChunk: async (i) => {
      calls.push(`chunk ${i.transferId}@${i.offset}`)
      written.set(i.transferId, [
        ...(written.get(i.transferId) ?? []),
        Buffer.from(i.data, 'base64')
      ])
    },
    sessionsFinish: async (_m, _t, transferId) => {
      calls.push(`finish ${transferId}`)
      return {
        conversationId: transferId.slice(2),
        epoch: 4,
        missing: Array.from({ length: opts.missing ?? 0 }, (_, i) => ({
          artifactId: `a${i}`,
          contentHash: 'h',
          name: 'n',
          kind: 'file',
          mediaType: 'text/plain',
          size: 4
        }))
      }
    },
    sessionsPutAttachment: async (i) => {
      calls.push(`put ${i.ref.artifactId} epoch ${i.epoch}`)
    },
    sessionsActivate: async (i) => {
      calls.push(`activate ${i.conversationId} epoch ${i.epoch}`)
    },
    sessionsImportLedger: async (_m, taskId, ledger) => {
      calls.push(`ledger ${taskId} ${JSON.stringify(ledger)}`)
    },
    sessionsRegister: async (_m, taskId, chats) => {
      calls.push(
        `register ${taskId} ${chats.map((c) => `${c.id}@${c.epoch}/${c.tabId}`).join(',')}`
      )
    }
  }
  const steps = createTaskMoveSteps({
    sourceHubId: 'hub-a',
    source: source as TaskMoveSourceApi,
    target: target as TaskMoveTargetApi
  })
  return { steps, calls, written, payload }
}

const progress = () => {
  const seen: Array<[number, number]> = []
  return { seen, report: async (done: number, total: number) => void seen.push([done, total]) }
}

describe('copy-sessions', () => {
  test('each chat goes in chunks, its attachments after, then activated; ledger and ownership last', async () => {
    const h = harness({
      transfers: [{ computerId: 'pc-a', manifest: manifest('c1', 600_000) }],
      missing: 1
    })
    const p = progress()
    await h.steps['copy-sessions']({ move: move(), reportProgress: p.report })

    expect(h.calls).toEqual([
      'export t1',
      'begin c1',
      'read c1@0',
      'chunk x-c1@0',
      'read c1@262144',
      'chunk x-c1@262144',
      'read c1@524288',
      'chunk x-c1@524288',
      'finish x-c1',
      // The attachment is read at the SOURCE epoch and put at the epoch the target staged.
      'attachment a0 epoch 3',
      'put a0 epoch 4',
      'activate c1 epoch 4',
      'ledger t1 {"rows":"t1"}',
      'register t1 c1@4/tab-c1',
      'discard'
    ])
    // The target got every byte, in order.
    expect(Buffer.concat(h.written.get('x-c1')!).equals(h.payload.get('c1')!)).toBe(true)
    // Progress counts bytes over everything to copy.
    expect(p.seen[0]).toEqual([0, 600_000])
    expect(p.seen.at(-1)).toEqual([600_000, 600_000])
  })

  test('a transfer continues where the target’s copy stands', async () => {
    const h = harness({
      transfers: [{ computerId: 'pc-a', manifest: manifest('c1', 600_000) }],
      resumeAt: 524_288
    })
    await h.steps['copy-sessions']({ move: move(), reportProgress: progress().report })
    expect(h.calls.filter((c) => c.startsWith('read'))).toEqual(['read c1@524288'])
    expect(Buffer.concat(h.written.get('x-c1')!)).toHaveLength(600_000 - 524_288)
  })

  test('a task with no chats still gets its ledger', async () => {
    const h = harness({ transfers: [] })
    await h.steps['copy-sessions']({ move: move(), reportProgress: progress().report })
    expect(h.calls).toEqual(['export t1', 'ledger t1 {"rows":"t1"}', 'register t1 ', 'discard'])
  })

  test('chats of several tasks go one task after another', async () => {
    const h = harness({ transfers: [{ computerId: 'pc-a', manifest: manifest('c1', 10) }] })
    await h.steps['copy-sessions']({
      move: move({ taskIds: ['t1', 't2'], rootTaskIds: ['t1', 't2'] }),
      reportProgress: progress().report
    })
    expect(h.calls.filter((c) => c.startsWith('register') || c.startsWith('export'))).toEqual([
      'export t1',
      'export t2',
      'register t1 c1@4/tab-c1',
      'register t2 c1@4/tab-c1'
    ])
  })

  test('a move that leaves its sessions behind copies nothing', async () => {
    const h = harness({ transfers: [{ computerId: 'pc-a', manifest: manifest('c1', 10) }] })
    await h.steps['copy-sessions']({
      move: move({ includeSessions: false }),
      reportProgress: progress().report
    })
    expect(h.calls).toEqual([])
  })

  test('an export that ends early fails the step instead of finishing a short chat', async () => {
    const h = harness({ transfers: [{ computerId: 'pc-a', manifest: manifest('c1', 100) }] })
    h.payload.set('c1', Buffer.alloc(0))
    await expect(
      h.steps['copy-sessions']({ move: move(), reportProgress: progress().report })
    ).rejects.toThrow(/ended early/)
    expect(h.calls.some((c) => c.startsWith('activate'))).toBe(false)
  })
})
