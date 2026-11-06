/**
 * Round-6 L4 at the gateway (round-7 N2): the classifier test pins WHICH requests are
 * new work; this one pins that a disabled computer really refuses them — the real
 * gateway, the guard the composed hub installs, a real computer dialer. Nothing is
 * sent for `exec.run`, a worktree `git.op` or a spawn; reads and kills still reach it;
 * enabled again, it works.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { createMemoryCredentialStore, HubDialer } from '@slayzone/computer-transport/client'
import { HubToComputerMethods as M } from '@slayzone/computer-transport/shared'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { startLoopbackHub } from '../../../domains/computer-transport/src/testing/loopback'
import { createNewWorkGuard } from './computer-new-work'

const h = await createTestHarness()
h.db
  .prepare(
    `INSERT INTO computers (id, name, platform, version, capabilities_json, created_at, disabled_at)
     VALUES ('computer-1', 'box', 'darwin', '1', '[]', 1, 1)`
  )
  .run()

const hub = await startLoopbackHub({ beforeRequest: createNewWorkGuard(h.slayDb) })
const commands = vi.fn(async () => ({ ok: true }))
const dialer = new HubDialer({
  url: hub.url,
  identity: { name: 'box', platform: 'darwin', version: '0.0.0', capabilities: [] },
  credentialStore: createMemoryCredentialStore(),
  joinToken: 'jt-valid',
  heartbeatIntervalMs: 0,
  onHubRequest: commands
})
dialer.start()
await dialer.events.once('connected')
afterAll(async () => {
  await dialer.stop()
  await hub.close()
})

const sentMethods = () => commands.mock.calls.map((c) => (c as unknown[])[0])

describe('L4: a disabled computer, through the gateway', () => {
  test('exec.run, a new worktree and a spawn are refused before anything is sent', async () => {
    commands.mockClear()
    for (const [method, params] of [
      [M.execRun, { command: 'claude -p x', timeoutMs: 1000 }],
      [M.gitOp, { op: 'addWorktree', input: {}, mutates: true }],
      [M.ptySpawn, {}],
      [M.procSpawn, {}]
    ] as const) {
      await expect(hub.gateway.request('computer-1', method, params), method).rejects.toThrow(
        /disabled/i
      )
    }
    expect(commands).not.toHaveBeenCalled()
  })

  test('reads, edits of what exists, and stops still reach it', async () => {
    commands.mockClear()
    await hub.gateway.request('computer-1', M.ptyList, {})
    await hub.gateway.request('computer-1', M.gitOp, {
      op: 'commitFiles',
      input: {},
      mutates: true
    })
    await hub.gateway.request('computer-1', M.procKill, { sessionId: 's' })
    expect(commands).toHaveBeenCalledTimes(3)
  })

  test('enabled again: exec.run goes through', async () => {
    h.db.prepare("UPDATE computers SET disabled_at = NULL WHERE id = 'computer-1'").run()
    commands.mockClear()
    await hub.gateway.request('computer-1', M.execRun, { command: 'true', timeoutMs: 1000 })
    expect(commands).toHaveBeenCalledTimes(1)
    expect(sentMethods()).toHaveLength(1)
  })
})

test('the composed hub installs this guard in its gateway', () => {
  const src = readFileSync(join(import.meta.dirname, 'composition.ts'), 'utf-8')
  expect(src).toMatch(/newWorkGuard\(computerId, method, params\)/)
  expect(src).toMatch(/const newWorkGuard = createNewWorkGuard\(db\)/)
})
