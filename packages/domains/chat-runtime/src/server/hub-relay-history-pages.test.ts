/**
 * History reads between hub and computer are bounded pages (2026-11-14: one 202 MB
 * `getBufferSince(-1)` answer closed the computer's socket, 1009). The relay asks a
 * computer that advertised `chatHistoryPages` for pages — also when an older hub
 * caller wants the whole history (it assembles the pages) — and an older computer
 * for the whole read it knows, as one last page.
 */
import { expect, test, vi } from 'vitest'
import {
  CHAT_HISTORY_PAGE_MAX_BYTES,
  clampChatHistoryPageBudget,
  cutChatHistoryPage,
  jsonByteLength,
  type ChatHistoryPageBudget,
  type ChatHistoryPageEvent
} from '@slayzone/terminal-contracts'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createChatOwnershipStore } from './hub-ownership'
import type { ChatComputerRequest } from './migration'
import { createHubChatRelay } from './hub-relay'

/** ~20 MB of saved events: some screenshot-sized. */
const history: ChatHistoryPageEvent[] = Array.from({ length: 2_000 }, (_, seq) => ({
  seq,
  at: seq,
  event: { kind: 'stderr', text: `${seq}:${'x'.repeat(seq % 40 === 0 ? 900_000 : 1_000)}` }
}))
const live = { afterSeq: history.length - 1, liveSeq: 3, events: [] }

/** What the computer answers a page read, cut like its store cuts one. */
function page(afterSeq: number, budget?: ChatHistoryPageBudget) {
  const rest = history.filter((e) => e.seq > afterSeq)
  const cut = cutChatHistoryPage(
    rest.map((e) => ({ seq: e.seq, bytes: jsonByteLength(e.event) })),
    clampChatHistoryPageBudget(budget)
  )
  const events = cut.through === null ? [] : rest.filter((e) => e.seq <= cut.through!)
  return { events, hasMore: cut.more }
}

async function setup(pages: boolean) {
  const h = await createTestHarness()
  h.db.exec(
    "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
  )
  const ownership = createChatOwnershipStore(h.slayDb)
  await ownership.register({
    id: 'store',
    taskId: 'task',
    tabId: 'tab',
    mode: 'claude-chat',
    computerId: 'pc',
    epoch: 1
  })
  /** Every history answer the computer sent, and its size. */
  const answers: Array<{ method: string; bytes: number }> = []
  const request = vi.fn<ChatComputerRequest>(async (_pc, raw) => {
    const p = raw as { kind: string; value: { method: string; args: unknown[] } }
    if (p.kind === 'pendingMetadata') return []
    if (p.kind !== 'invoke') throw new Error('Unexpected request')
    const [, afterSeq, budget] = p.value.args as [string, number, ChatHistoryPageBudget?]
    let answer: unknown
    if (p.value.method === 'getEventPage' && pages) answer = page(afterSeq, budget)
    else if (p.value.method === 'getReplayPage' && pages) {
      const got = page(afterSeq, budget)
      answer = got.hasMore ? got : { ...got, live }
    } else if (p.value.method === 'getBufferSince') answer = history.filter((e) => e.seq > afterSeq)
    else if (p.value.method === 'getReplay')
      answer = { events: history.filter((e) => e.seq > afterSeq), live }
    else throw new Error(`Unknown chat operation ${p.value.method}`)
    answers.push({ method: p.value.method, bytes: jsonByteLength(answer) })
    return answer
  })
  const relay = createHubChatRelay({
    db: h.slayDb,
    ownership,
    request,
    chatHistoryPages: () => pages,
    resolveComputer: async () => 'pc',
    defaultComputer: async () => 'pc',
    bootstrap: async () => {
      throw new Error('No bootstrap expected')
    },
    migrate: async () => {
      throw new Error('No migration expected')
    }
  })
  return { h, relay, answers }
}

const whole = history

test('a computer with pages: a page read is forwarded with its budget', async () => {
  const { h, relay, answers } = await setup(true)
  try {
    const first = await relay.ops.getEventPage('tab', -1, { maxBytes: 100_000 })
    expect(first.hasMore).toBe(true)
    expect(first.events[0].seq).toBe(0)
    expect(answers).toEqual([{ method: 'getEventPage', bytes: expect.any(Number) }])
    expect(answers[0].bytes).toBeLessThan(1_000_000)
    const replay = await relay.ops.getReplayPage('tab', 1_990)
    expect(replay).toEqual({ events: whole.slice(1_991), hasMore: false, live })
  } finally {
    h.cleanup()
  }
})

test('a computer with pages: a whole-history read (an older caller) is assembled from bounded pages', async () => {
  const { h, relay, answers } = await setup(true)
  try {
    expect(await relay.ops.getBufferSince('tab', -1)).toEqual(whole)
    expect(await relay.ops.getReplay('tab', 99)).toEqual({ events: whole.slice(100), live })
    expect(answers.length).toBeGreaterThan(4)
    expect(new Set(answers.map((a) => a.method))).toEqual(
      new Set(['getEventPage', 'getReplayPage'])
    )
    for (const a of answers)
      expect(a.bytes).toBeLessThanOrEqual(CHAT_HISTORY_PAGE_MAX_BYTES + 64 * 1024)
  } finally {
    h.cleanup()
  }
})

test('an older computer (no pages): a page read asks for its whole read once and answers it as the last page', async () => {
  const { h, relay, answers } = await setup(false)
  try {
    expect(await relay.ops.getEventPage('tab', 1_990)).toEqual({
      events: whole.slice(1_991),
      hasMore: false
    })
    expect(await relay.ops.getReplayPage('tab', 1_990)).toEqual({
      events: whole.slice(1_991),
      hasMore: false,
      live
    })
    expect(await relay.ops.getBufferSince('tab', 1_995)).toEqual(whole.slice(1_996))
    expect(answers.map((a) => a.method)).toEqual(['getBufferSince', 'getReplay', 'getBufferSince'])
  } finally {
    h.cleanup()
  }
})
