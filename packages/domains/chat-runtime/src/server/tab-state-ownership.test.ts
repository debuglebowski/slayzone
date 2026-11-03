import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'

function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'chat-tab-state-ownership-'))
  const runtime = createComputerChatRuntime({
    stateDir: dir,
    hubScope: 'test',
    computerId: 'pc',
    transport: {
      spawn: () => {
        throw new Error('Provider execution forbidden')
      }
    }
  })
  const first = { id: 'first', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 }
  const bootstrap = (identity: typeof first) =>
    runtime.bootstrap({
      identity,
      projectId: null,
      cwd: dir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
  bootstrap(first)
  return {
    runtime,
    first,
    bootstrap,
    async close() {
      await runtime.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
const scope = (owner: { id: string; epoch: number; mode: string }) => ({
  expectedMode: owner.mode,
  expectedOwnership: { id: owner.id, epoch: owner.epoch }
})

test('scoped empty tab state exposes current ownership without changing legacy null reads', async () => {
  const f = fixture(),
    r = f.runtime
  try {
    expect(await r.ops.getTabState('tab')).toBeNull()
    expect(
      await r.invoke({
        route: { id: f.first.id, epoch: 1 },
        target: 'ops',
        method: 'getTabState',
        args: ['tab', { expectedMode: 'claude-chat' }]
      })
    ).toEqual({
      draft: { text: '', attachments: [], rev: 0 },
      scroll: null,
      ownership: { id: f.first.id, epoch: 1 }
    })
    await expect(
      r.invoke({
        route: { id: f.first.id, epoch: 1 },
        target: 'ops',
        method: 'getTabState',
        args: ['tab', { expectedMode: 'codex-chat' }]
      })
    ).rejects.toThrow(/provider changed/)
  } finally {
    await f.close()
  }
})

test('same-provider round trip fences old draft and scroll saves by identity, including direct data writes', async () => {
  const f = fixture(),
    r = f.runtime
  try {
    await r.ops.saveTabDraft('tab', { text: 'original Claude draft', attachments: [] })
    const codex = { ...f.first, id: 'codex', mode: 'codex-chat' }
    await r.transitionTab({
      id: 'switch-1',
      from: f.first,
      to: { ...f.first, tabId: 'archived-claude', epoch: 2 },
      next: codex
    })
    f.bootstrap(codex)
    const current = { ...f.first, id: 'new-claude' }
    await r.transitionTab({
      id: 'switch-2',
      from: codex,
      to: { ...codex, tabId: 'archived-codex', epoch: 2 },
      next: current
    })
    f.bootstrap(current)
    await r.ops.saveTabDraft('tab', { text: 'new Claude edits', attachments: [] })
    await r.ops.saveTabScroll('tab', { atBottom: false, key: 'current', offsetPx: 42 })
    for (const method of ['saveTabDraft', 'saveTabScroll'] as const) {
      const value =
        method === 'saveTabDraft' ? { text: 'late old edit', attachments: [] } : { atBottom: true }
      await expect(
        r.invoke({
          route: { id: current.id, epoch: current.epoch },
          target: 'ops',
          method,
          args: ['tab', value, scope(f.first)],
          operationId: `stale-${method}`
        })
      ).rejects.toThrow(/ownership changed/)
      expect(r.storage.receipt(current.id, `stale-${method}`)).toBeNull()
    }
    await expect(
      r.local.data.saveTabDraft(
        'tab',
        { text: 'late direct write', attachments: [] },
        scope(f.first)
      )
    ).rejects.toThrow(/ownership changed/)
    await expect(
      r.local.data.saveTabScroll('tab', { atBottom: true }, scope(f.first))
    ).rejects.toThrow(/ownership changed/)
    expect(await r.ops.getTabState('tab')).toMatchObject({
      draft: { text: 'new Claude edits' },
      scroll: { atBottom: false, key: 'current', offsetPx: 42 }
    })
    await expect(
      r.local.data.saveTabDraft(
        'archived-claude',
        { text: 'stale epoch', attachments: [] },
        scope(f.first)
      )
    ).rejects.toThrow(/ownership changed/)
    await expect(
      r.ops.saveTabDraft('tab', { text: 'valid new edit', attachments: [] }, scope(current))
    ).resolves.toHaveProperty('rev')
    expect((await r.ops.getTabState('tab'))?.draft.text).toBe('valid new edit')
  } finally {
    await f.close()
  }
})
