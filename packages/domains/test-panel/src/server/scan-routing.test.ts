/**
 * The test panel's scan reads the project's files, so it runs on the project's
 * computer (resolved from the checkout path, else the project): the hub sends the
 * category patterns. No computer, on any hub: `NO_COMPUTER_CONNECTED` — the hub's
 * own disk is never scanned.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { TRPCError } from '@trpc/server'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { testPanelRouter } from './router'
import { setTestScanRouting } from './scan-routing'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')
const caller = testPanelRouter.createCaller({ db: h.slayDb, dataRoot: '' } as never)
await caller.createCategory({ project_id: projectId, name: 'Unit', pattern: '**/*.test.ts' })

const asked: Array<{ computerId: string; input: unknown }> = []
let computer: string | null = 'c1'

afterEach(() => {
  asked.length = 0
  computer = 'c1'
  setTestScanRouting(null)
  delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
})

function route(): void {
  setTestScanRouting({
    computerFor: async () => computer,
    scan: async (computerId, input) => {
      asked.push({ computerId, input })
      return { matches: [{ path: 'a.test.ts', categoryId: 'x' }], totalScanned: 1 }
    }
  })
}

describe('test scan on the computer', () => {
  test("runs on the project's computer with the project's patterns — processes-off hub too", async () => {
    route()
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    const out = await caller.scanFiles({ projectPath: '/remote/p', projectId })
    expect(out.totalScanned).toBe(1)
    expect(asked[0]).toMatchObject({
      computerId: 'c1',
      input: { projectPath: '/remote/p', categories: [{ pattern: '**/*.test.ts' }] }
    })
  })

  test('no computer, on any hub: NO_COMPUTER_CONNECTED, nothing scanned', async () => {
    route()
    computer = null
    // A checkout that exists on THIS disk: still not scanned here.
    const local = mkdtempSync(join(tmpdir(), 'slz-scan-'))
    writeFileSync(join(local, 'a.test.ts'), '')
    const err = await caller.scanFiles({ projectPath: local, projectId }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TRPCError)
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect(asked).toHaveLength(0)
  })
})
