import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { expect, test } from 'vitest'
import {
  CHAT_HISTORY_PAGE_MAX_BYTES,
  CHAT_HISTORY_PAGE_MAX_EVENTS,
  jsonByteLength,
  type AgentEvent
} from '@slayzone/terminal-contracts'
import { decodeTimelineState } from '@slayzone/terminal/timeline-checkpoint'
import { TimelineProjection } from '@slayzone/terminal/timeline-projection'
import { timelineStoreFromRecords } from '@slayzone/terminal/timeline-records'
import { createLocalChatData } from '../local-data'
import { openChatStorage, type ChatStorage } from '../storage'

const KIB = 1024
const MIB = 1024 * KIB
const TURNS = 2500
const IDENTITY = { id: 'chat', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
const READ_BUDGET = {
  maxBytes: CHAT_HISTORY_PAGE_MAX_BYTES,
  maxEvents: CHAT_HISTORY_PAGE_MAX_EVENTS
}

function seed(store: ChatStorage): number {
  store.createConversation(IDENTITY)
  const output = 'å'.repeat(4 * KIB)
  const largeResult = 'x'.repeat(2 * MIB)
  let seq = 0
  store.transaction(() => {
    for (let turn = 0; turn < TURNS; turn++) {
      const userId = `user-${turn}`
      const toolUseId = `tool-${turn}`
      const taskId = `command-${turn}`
      const command = {
        kind: 'command-task',
        toolUseId,
        taskId,
        backgrounded: true
      } as const
      const events: AgentEvent[] = [
        { kind: 'user-message', id: userId, text: 'Run the build' },
        { kind: 'user-message-delivery', id: userId, state: 'delivered' },
        { kind: 'tool-call', id: toolUseId, name: 'Bash', input: { command: 'pnpm build' } },
        { ...command, status: 'running' },
        {
          kind: 'tool-result',
          toolUseId,
          rawContent: turn === TURNS - 1 ? largeResult : 'Build started',
          structured: null,
          isError: false
        },
        { kind: 'assistant-text', messageId: `reply-${turn}`, text: 'Build started.' },
        {
          kind: 'result',
          subtype: 'success',
          isError: false,
          durationMs: 10,
          durationApiMs: 10,
          numTurns: 1,
          totalCostUsd: 0,
          stopReason: null,
          terminalReason: null,
          text: null,
          modelUsage: {},
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0
          },
          permissionDenials: []
        },
        { kind: 'user-message-delivery', id: userId, state: 'answered' },
        { ...command, status: 'completed' },
        {
          kind: 'command-task-output',
          toolUseId,
          taskId,
          output,
          totalBytes: 8 * KIB,
          truncated: false
        }
      ]
      for (const event of events) {
        store.appendAt(IDENTITY.id, IDENTITY.epoch, seq, event, 1_000 + seq)
        seq++
      }
    }
    const material = 'large write payload\n'.repeat(39_000) + 'unpreviewed source'
    for (const event of [
      {
        kind: 'tool-call',
        id: 'large-write',
        name: 'Write',
        input: { file_path: '/repo/file', content: material }
      },
      {
        kind: 'tool-result',
        toolUseId: 'large-write',
        rawContent: 'saved',
        isError: false,
        structured: { type: 'create', filePath: '/repo/file', content: material }
      },
      { kind: 'tool-call', id: 'running-tool', name: 'Monitor', input: {} },
      {
        kind: 'command-task',
        taskId: 'running-command',
        toolUseId: 'running-tool',
        backgrounded: true,
        status: 'running'
      }
    ] satisfies AgentEvent[]) {
      store.appendAt(IDENTITY.id, IDENTITY.epoch, seq, event, 1_000 + seq)
      seq++
    }
  })
  return seq - 1
}

test('a 25k-event chat keeps completed command output out of the open indexes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slz-chat-open-budget-'))
  const store = openChatStorage({ stateDir: root, hubScope: 'test' })
  try {
    const lastSeq = seed(store)
    const { data } = createLocalChatData(store)
    const projection = await TimelineProjection.open({
      store: timelineStoreFromRecords(data.timelineRecords!(IDENTITY.tabId)),
      history: {
        lastSeq,
        async *pages(afterSeq) {
          let after = afterSeq
          for (;;) {
            const page = store.readPage(IDENTITY.id, after, lastSeq + 1, READ_BUDGET)
            if (!page.events.length) return
            yield page.events
            if (!page.more) return
            after = page.events[page.events.length - 1].seq
          }
        }
      },
      agentStartedTurns: true
    })
    try {
      const snapshot = await projection.openSnapshot()
      const decoded = decodeTimelineState(snapshot.state)
      expect(snapshot.seq).toBe(lastSeq)
      expect(snapshot.summaries.length).toBeGreaterThan(8)
      // Deliberately a byte budget. Timings from shared CI hosts are noisy.
      expect(jsonByteLength(snapshot)).toBeLessThan(5 * MIB)
      expect([...decoded.commandTasks.keys()]).toEqual(['running-tool'])
      const compact = await projection.openSnapshot('benchmark')
      expect(compact.toolPreviews).toBe(true)
      expect(compact.state.includes('unpreviewed source')).toBe(false)
      expect(jsonByteLength(compact)).toBeLessThan(1.5 * MIB)
      const deflateBytes = (value: unknown) =>
        deflateRawSync(JSON.stringify(value), { level: 3, memLevel: 6 }).length
      expect(deflateBytes(compact)).toBeLessThan(80 * KIB)
      const display = { windowed: true } as const
      const window = await projection.openSnapshot('benchmark', display)
      expect(window.windowed).toBe(true)
      expect(decodeTimelineState(window.state).timeline.filter(Boolean).length).toBeLessThan(32)
      expect(deflateBytes(window)).toBeLessThan(deflateBytes(compact))
      const newestPage = window.summaries.length - 1
      const windowPage = await projection.pagesAsOf(
        [newestPage],
        window.seq,
        window.epoch,
        newestPage * window.pageRows,
        'benchmark',
        display
      )
      expect(windowPage.expired).toBe(false)
      expect(jsonByteLength(windowPage)).toBeLessThan(100 * KIB)
      expect(deflateBytes(windowPage)).toBeLessThan(12 * KIB)
      const sealed = snapshot.summaries.length - 1
      const page = await projection.pagesAsOf(
        [sealed],
        snapshot.seq,
        snapshot.epoch,
        sealed * snapshot.pageRows
      )
      expect(page.expired).toBe(false)
      if (page.expired) return
      expect(jsonByteLength(page)).toBeLessThan(MIB)
      const previews = await projection.pagesAsOf(
        [sealed],
        compact.seq,
        compact.epoch,
        sealed * compact.pageRows,
        'benchmark'
      )
      expect(previews.expired).toBe(false)
      expect(jsonByteLength(previews)).toBeLessThan(128 * KIB)
      expect(deflateBytes(previews)).toBeLessThan(30 * KIB)
      expect(
        page.pages[0].rows.some(
          (row) => row.kind === 'tool' && row.invocation.task?.finalOutput?.totalBytes === 8 * KIB
        )
      ).toBe(true)
    } finally {
      await projection.close()
    }
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
