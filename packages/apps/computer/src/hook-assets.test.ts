import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { stageComputerHooks } from './agent-hooks'
import { buildSpawnEnv } from './handlers/spawn-env'

it('rollback changes new session hook selection without changing existing release files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-hook-assets-'))
  try {
    const first = await stageComputerHooks(root, '1.0.0')
    const before = readFileSync(join(first, 'notify.sh'), 'utf8')
    const second = await stageComputerHooks(root, '2.0.0')
    const ctx = {
      config: { hubUrl: 'ws://localhost', name: 'test', allowedRoots: [root], capabilities: [] },
      log: () => {},
      dialer: { notify: () => true },
      hookDirectory: second
    }
    const running = buildSpawnEnv(ctx)
    ctx.hookDirectory = first
    const rolledBack = buildSpawnEnv(ctx, { SLAYZONE_COMPUTER_HOOK_DIR: '/untrusted' })
    expect(running.SLAYZONE_COMPUTER_HOOK_DIR).toBe(second.replace(/\\/g, '/'))
    expect(rolledBack.SLAYZONE_COMPUTER_HOOK_DIR).toBe(first.replace(/\\/g, '/'))
    expect(readFileSync(join(first, 'notify.sh'), 'utf8')).toBe(before)
    expect(await stageComputerHooks(root, '1.0.0')).toBe(first)
    await expect(stageComputerHooks(root, '../../bad')).rejects.toThrow()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
