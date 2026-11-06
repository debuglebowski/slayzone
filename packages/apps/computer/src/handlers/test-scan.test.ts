/**
 * `testPanel.scan`: the test panel's file scan runs where the project is — the
 * same scanner the hub used — inside the jail.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { createTestScanHandlers } from './test-scan'

let dir: string
let scan: (params: unknown) => Promise<unknown>

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-test-scan-')))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.test.ts'), '')
  writeFileSync(join(dir, 'src', 'a.ts'), '')
  writeFileSync(join(dir, 'node_modules', 'x', 'b.test.ts'), '')
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [realpathSync(tmpdir())],
    capabilities: []
  }
  const handlers = createTestScanHandlers({ dialer: { notify: () => true }, config, log: () => {} })
  scan = (params) =>
    Promise.resolve(
      (handlers[HubToComputerMethods.testPanelScan] as (p: unknown) => unknown)(params)
    )
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('testPanel.scan', () => {
  it('matches the categories here, skipping the usual dirs', async () => {
    expect(
      await scan({ projectPath: dir, categories: [{ id: 'unit', pattern: '**/*.test.ts' }] })
    ).toEqual({ matches: [{ path: 'src/a.test.ts', categoryId: 'unit' }], totalScanned: 2 })
  })

  it('refuses a folder outside its roots', async () => {
    await expect(scan({ projectPath: '/etc', categories: [] })).rejects.toThrow(/outside/)
  })
})
