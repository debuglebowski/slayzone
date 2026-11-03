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
})
