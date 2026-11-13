/**
 * `usage.collect`: the agents' usage logs are on THIS computer (`~/.claude`, …), so
 * it parses them here — the same parsers the hub used — from the read offsets it
 * keeps itself (v209), and answers only what is new.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import type { UsageCursors, UsageCursorStore } from '@slayzone/usage-analytics/collect'
import type { ComputerConfig } from '../config'
import { createUsageCollectHandlers } from './usage-collect'

/** This computer's cursor store (its chat store in production). */
function memoryCursors(): UsageCursorStore & { map: UsageCursors } {
  const map: UsageCursors = {}
  return {
    map,
    all: () => ({ ...map }),
    seed: (c) => {
      for (const [k, v] of Object.entries(c)) map[k] ??= v
    },
    commit: (entries) => {
      for (const e of entries) map[e.sourceFile] = { offset: e.offset, modifiedMs: e.modifiedMs }
    }
  }
}

let home: string
const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
let collect: (params: unknown) => Promise<unknown>
let store: ReturnType<typeof memoryCursors>

const line = (id: string) =>
  `${JSON.stringify({
    type: 'assistant',
    requestId: id,
    sessionId: 's1',
    timestamp: '2026-11-01T00:00:00Z',
    message: { id, model: 'm', usage: { input_tokens: 3, output_tokens: 4 } }
  })}\n`

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'computer-usage-')))
  process.env.HOME = home
  delete process.env.CLAUDE_CONFIG_DIR
  store = memoryCursors()
  mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true })
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [home],
    capabilities: []
  }
  const handlers = createUsageCollectHandlers(
    { dialer: { notify: () => true }, config, log: () => {} },
    { cursors: () => store }
  )
  collect = (params) =>
    Promise.resolve(
      (handlers[HubToComputerMethods.usageCollect] as (p: unknown) => unknown)(params)
    )
})

afterEach(() => {
  process.env.HOME = saved.HOME
  if (saved.CLAUDE_CONFIG_DIR !== undefined) process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR
  rmSync(home, { recursive: true, force: true })
})

describe('usage.collect', () => {
  it("parses this computer's logs from its own cursors, moved only once acknowledged", async () => {
    const file = join(home, '.claude', 'projects', 'p', 's.jsonl')
    writeFileSync(file, line('a'))
    type Reply = {
      results: Array<{ sourceFile: string; records: Array<{ id: string }> }>
      receipt?: unknown
    }
    const mine = (r: Reply) => r.results.filter((x) => x.sourceFile === file)
    const first = (await collect({})) as Reply
    expect(mine(first)[0]?.records.map((r) => r.id)).toHaveLength(1)
    expect(store.map[file], 'not before the hub stored it').toBeUndefined()
    await collect({ ack: first.receipt })
    expect(store.map[file]?.offset).toBe(statSync(file).size)

    const later = new Date(statSync(file).mtimeMs + 5000)
    writeFileSync(file, line('a') + line('b'))
    utimesSync(file, later, later)
    const next = (await collect({})) as Reply
    expect(mine(next)[0]?.records, 'only what is new').toHaveLength(1)
  })

  // A first collect after the update (or of a fresh computer) is the whole backlog:
  // 81 MiB measured on a real machine, and over the WebSocket's 100 MiB message limit
  // for a heavier one — the computer's socket closes and every terminal detaches.
  // The reply is paged: no message exceeds the byte budget, nothing is lost, and a
  // file split across pages keeps its old cursor until its last page.
  it('a large backlog comes back in pages under the byte budget', async () => {
    const PAGE = 64 * 1024
    const config: ComputerConfig = {
      hubUrl: 'ws://localhost:0/computers',
      name: 'test',
      allowedRoots: [home],
      capabilities: []
    }
    const handlers = createUsageCollectHandlers(
      { dialer: { notify: () => true }, config, log: () => {} },
      { pageBytes: PAGE, cursors: () => memoryCursors() }
    )
    const call = (p: unknown) =>
      Promise.resolve((handlers[HubToComputerMethods.usageCollect] as (q: unknown) => unknown)(p))
    const big = join(home, '.claude', 'projects', 'p', 'big.jsonl')
    const small = join(home, '.claude', 'projects', 'p', 'small.jsonl')
    const LINES = 4000
    writeFileSync(big, Array.from({ length: LINES }, (_, i) => line(`big-${i}`)).join(''))
    writeFileSync(small, line('small-1'))

    type Page = {
      results: Array<{
        sourceFile: string
        endOffset: number
        complete?: boolean
        records: Array<{ id: string }>
      }>
      next?: unknown
    }
    const pages: Page[] = []
    let reply = (await call({})) as Page
    pages.push(reply)
    while (reply.next) {
      reply = (await call({ page: reply.next })) as Page
      pages.push(reply)
      expect(pages.length, 'pages end').toBeLessThan(200)
    }
    expect(pages.length, 'more than one page').toBeGreaterThan(2)
    for (const p of pages) {
      expect(JSON.stringify(p).length, 'each reply within the budget').toBeLessThan(PAGE * 1.25)
    }
    const bigEntries = pages.flatMap((p) => p.results.filter((r) => r.sourceFile === big))
    expect(bigEntries.flatMap((r) => r.records.map((x) => x.id))).toHaveLength(LINES)
    expect(
      bigEntries.filter((r) => r.complete !== false),
      'only its last chunk completes'
    ).toHaveLength(1)
    expect(bigEntries.at(-1)?.complete).not.toBe(false)
    for (const partial of bigEntries.slice(0, -1)) {
      expect(partial.endOffset, "a partial chunk keeps the file's old cursor").toBe(0)
    }
    expect(bigEntries.at(-1)?.endOffset).toBe(statSync(big).size)
    expect(pages.flatMap((p) => p.results).some((r) => r.sourceFile === small)).toBe(true)
  })
})

describe('usage.collect attribution', () => {
  it('tags each record with the task its session ledger names (the ledger is only here)', async () => {
    writeFileSync(join(home, '.claude', 'projects', 'p', 's.jsonl'), line('a') + line('b'))
    const handlers = createUsageCollectHandlers(
      { dialer: { notify: () => true }, config: {} as ComputerConfig, log: () => {} },
      {
        cursors: () => memoryCursors(),
        taskOf: (ids) => Object.fromEntries(ids.filter((i) => i === 's1').map((i) => [i, 'task-1']))
      }
    )
    const reply = (await (handlers[HubToComputerMethods.usageCollect] as (p: unknown) => unknown)(
      {}
    )) as { results: Array<{ records: Array<{ taskId: string | null; sessionId: string }> }> }
    const records = reply.results.flatMap((r) => r.records)
    expect(records.length).toBe(2)
    expect(records.every((r) => r.taskId === 'task-1')).toBe(true)
  })

  it('a record no session names is attributed by its folder: the task whose worktree it is (§9 7c)', async () => {
    const withCwd = (id: string, session: string, cwd: string) =>
      `${JSON.stringify({
        type: 'assistant',
        requestId: id,
        sessionId: session,
        cwd,
        timestamp: '2026-11-01T00:00:00Z',
        message: { id, model: 'm', usage: { input_tokens: 3, output_tokens: 4 } }
      })}\n`
    writeFileSync(
      join(home, '.claude', 'projects', 'p', 's.jsonl'),
      withCwd('a', 's1', '/wt/one') +
        withCwd('b', 'other', '/wt/one') +
        withCwd('c', 'x', '/nowhere')
    )
    const handlers = createUsageCollectHandlers(
      { dialer: { notify: () => true }, config: {} as ComputerConfig, log: () => {} },
      {
        cursors: () => memoryCursors(),
        taskOf: (ids) =>
          Object.fromEntries(ids.filter((i) => i === 's1').map((i) => [i, 'by-session'])),
        taskOfCwd: (cwds) =>
          Object.fromEntries(cwds.filter((c) => c === '/wt/one').map((c) => [c, 'by-folder']))
      }
    )
    const reply = (await (handlers[HubToComputerMethods.usageCollect] as (p: unknown) => unknown)(
      {}
    )) as { results: Array<{ records: Array<{ id: string; taskId: string | null }> }> }
    const byId = Object.fromEntries(
      reply.results.flatMap((r) => r.records).map((r) => [r.id, r.taskId ?? null])
    )
    // The session's task wins; the folder decides only for a session it does not name.
    expect(Object.values(byId).sort()).toEqual([null, 'by-folder', 'by-session'].sort())
  })

  it('a hub without a ledger yet leaves records unattributed', async () => {
    writeFileSync(join(home, '.claude', 'projects', 'p', 's.jsonl'), line('a'))
    const handlers = createUsageCollectHandlers(
      { dialer: { notify: () => true }, config: {} as ComputerConfig, log: () => {} },
      {
        cursors: () => memoryCursors(),
        taskOf: () => {
          throw new Error('Chat runtime is shutting down')
        }
      }
    )
    const reply = (await (handlers[HubToComputerMethods.usageCollect] as (p: unknown) => unknown)(
      {}
    )) as { results: Array<{ records: Array<{ taskId: string | null }> }> }
    expect(reply.results.flatMap((r) => r.records).map((r) => r.taskId ?? null)).toEqual([null])
  })
})
