/**
 * FU5 (computer stalls): `agentConfig.fs hashFiles` judges every path it is given
 * (≤ 128) before it hashes any. Judged in one go, the whole batch was one block of
 * the event loop; it now turns the loop between chunks, so other requests and
 * heartbeats interleave.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'

/** Advanced by a setImmediate loop: it moves only when the event loop turns. */
const loop = vi.hoisted(() => ({ turns: 0, seen: [] as number[] }))
vi.mock('../path-jail', async (importOriginal) => {
  const jail = await importOriginal<typeof import('../path-jail')>()
  return {
    ...jail,
    judgePath: (...args: Parameters<typeof jail.judgePath>) => {
      loop.seen.push(loop.turns)
      return jail.judgePath(...args)
    }
  }
})
const { createAgentConfigHandlers } = await import('./agent-config')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('hashFiles judges its paths in chunks, turning the event loop between them', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-config-yield-')))
  dirs.push(root)
  const paths = Array.from({ length: 128 }, (_, i) => {
    const path = join(root, `f${i}.md`)
    writeFileSync(path, `${i}`)
    return path
  })
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [root],
    capabilities: []
  }
  const handlers = createAgentConfigHandlers(
    { dialer: { notify: () => true }, config, log: () => {} },
    () => root
  )
  let running = true
  const spin = () => {
    loop.turns++
    if (running) setImmediate(spin)
  }
  setImmediate(spin)
  loop.seen.length = 0
  const answer = (await (handlers[HubToComputerMethods.agentConfigFs] as (p: unknown) => unknown)({
    op: 'hashFiles',
    paths
  })) as { result: unknown[] }
  running = false
  expect(answer.result).toHaveLength(128)
  expect(loop.seen).toHaveLength(128)
  // Several distinct loop turns observed while judging: not one block.
  expect(new Set(loop.seen).size).toBeGreaterThan(2)
})
