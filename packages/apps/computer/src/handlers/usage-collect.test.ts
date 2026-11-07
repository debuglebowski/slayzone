/**
 * `usage.collect`: the agents' usage logs are on THIS computer (`~/.claude`, …), so
 * it parses them here — the same parsers the hub used — from the cursors the hub
 * keeps, and answers only what is new.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { createUsageCollectHandlers } from './usage-collect'

let home: string
const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
let collect: (params: unknown) => Promise<unknown>

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
  mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true })
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [home],
    capabilities: []
  }
  const handlers = createUsageCollectHandlers({
    dialer: { notify: () => true },
    config,
    log: () => {}
  })
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
  it("parses this computer's logs, and from a cursor only what is new", async () => {
    const file = join(home, '.claude', 'projects', 'p', 's.jsonl')
    writeFileSync(file, line('a'))
    const first = (await collect({ cursors: {} })) as {
      results: Array<{
        sourceFile: string
        endOffset: number
        fileMtimeMs: number
        records: unknown[]
      }>
    }
    const mine = first.results.filter((r) => r.sourceFile === file)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.records).toHaveLength(1)

    writeFileSync(file, line('a') + line('b'))
    const next = (await collect({
      cursors: { [file]: { offset: mine[0]!.endOffset, modifiedMs: mine[0]!.fileMtimeMs - 1 } }
    })) as { results: Array<{ sourceFile: string; records: Array<{ id: string }> }> }
    const again = next.results.filter((r) => r.sourceFile === file)
    expect(again[0]?.records).toHaveLength(1)
    expect(statSync(file).size).toBeGreaterThan(0)
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
      { pageBytes: PAGE }
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
    let reply = (await call({ cursors: {} })) as Page
    pages.push(reply)
    while (reply.next) {
      reply = (await call({ cursors: {}, page: reply.next })) as Page
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
