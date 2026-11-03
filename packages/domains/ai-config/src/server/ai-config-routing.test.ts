/**
 * The AI-config ops read and write the files where they live: a project's on the
 * project's computer, the computer-level ones (`~/.claude`, …) on an explicit
 * computer, else the caller's own — every fs call one `agentConfig.fs` request. So
 * they work on a hub with processes switched off; with no computer, the hub's own
 * disk is refused there (`NO_COMPUTER_CONNECTED`).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { TRPCError } from '@trpc/server'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { initAiConfigOps } from '@slayzone/ai-config/server'
import { aiConfigRouter } from './ai-config-router.js'
import { localAiConfigFs } from './ai-config-fs'
import { setAiConfigFsRouting, type AiConfigFsCall } from './ai-config-fs-routing'

const h = await createTestHarness()
const projectPath = h.tmpDir()
const computerHome = h.tmpDir()
fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), 'project instructions')

const calls: Array<{ computerId: string; call: AiConfigFsCall }> = []
const targets: unknown[] = []
let computer: string | null = 'c1'

/** A computer: its own disk via the same local fs, its own home. */
async function serve(computerId: string, call: AiConfigFsCall): Promise<unknown> {
  calls.push({ computerId, call })
  const f = localAiConfigFs
  switch (call.op) {
    case 'homedir':
      return computerHome
    case 'exists':
      return f.exists(call.path)
    case 'readFile':
      return f.readFile(call.path)
    case 'writeFile':
      return f.writeFile(call.path, call.content)
    case 'mkdir':
      return f.mkdir(call.path)
    case 'unlink':
      return f.unlink(call.path)
    case 'rmdir':
      return f.rmdir(call.path)
    case 'rename':
      return f.rename(call.path, call.to)
    case 'stat':
      return f.stat(call.path)
    case 'readdir':
      return f.readdir(call.path)
  }
}

beforeAll(async () => {
  await initAiConfigOps(h.slayDb)
})

function route(): void {
  setAiConfigFsRouting({
    computerForProject: async (t) => {
      targets.push(t)
      return computer
    },
    computerForCaller: async (id) => {
      targets.push({ caller: id ?? null })
      return computer
    },
    request: serve
  })
}

afterEach(() => {
  calls.length = 0
  targets.length = 0
  computer = 'c1'
  setAiConfigFsRouting(null)
  delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
})

const caller = aiConfigRouter.createCaller({ db: h.slayDb, dataRoot: '' } as never)

describe('AI config on the computer', () => {
  test("a project file is read on the project's computer — on a processes-off hub too", async () => {
    route()
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    const content = await caller.readContextFile({
      filePath: path.join(projectPath, 'CLAUDE.md'),
      projectPath
    })
    expect(content).toBe('project instructions')
    expect(targets[0]).toMatchObject({ projectPath })
    expect(calls.some((c) => c.computerId === 'c1' && c.call.op === 'readFile')).toBe(true)
  })

  test("computer-level files: that computer's home, an explicit computer first", async () => {
    route()
    fs.mkdirSync(path.join(computerHome, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(computerHome, '.claude', 'CLAUDE.md'), 'global')
    const files = await caller.getComputerFiles({ computerId: 'c1' })
    expect(targets).toEqual([{ caller: 'c1' }])
    expect(JSON.stringify(files)).toContain(path.join(computerHome, '.claude', 'CLAUDE.md'))
  })

  test('no computer on a processes-off hub: NO_COMPUTER_CONNECTED, nothing read', async () => {
    route()
    computer = null
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    const err = await caller
      .readContextFile({ filePath: path.join(projectPath, 'CLAUDE.md'), projectPath })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TRPCError)
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect(calls).toHaveLength(0)
  })
})
