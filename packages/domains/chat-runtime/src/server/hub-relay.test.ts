import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createComputerChatRuntime } from './computer-runtime'
import { createChatOwnershipStore } from './hub-ownership'
import { createHubChatRelay } from './hub-relay'

test('folder locators recover when child metadata arrives before its parent', async () => {
  const h = await createTestHarness()
  try {
    h.db.exec(
      "INSERT INTO projects(id,name,color) VALUES('p','P','#000'); INSERT INTO tasks(id,project_id,title) VALUES('task','p','T'); INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
    )
    const ownership = createChatOwnershipStore(h.slayDb)
    await ownership.register({
      id: 'c',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc',
      epoch: 1
    })
    const relay = createHubChatRelay({
      db: h.slayDb,
      ownership,
      request: async () => null,
      resolveComputer: async () => 'pc',
      defaultComputer: async () => 'pc',
      bootstrap: async () => {
        throw new Error('Metadata must not bootstrap')
      },
      migrate: async () => {
        throw new Error('Metadata must not migrate')
      }
    })
    for (const [sequence, value] of [
      { id: 'child', parentId: 'parent', order: 2 },
      { id: 'parent', parentId: null, order: 1 }
    ].entries()) {
      await relay.reconcileMetadata('pc', {
        conversationId: 'c',
        taskId: 'task',
        tabId: 'tab',
        epoch: 1,
        operationId: `folder-${sequence}`,
        sequence: sequence + 1,
        kind: 'folder-changed',
        value
      })
    }
    expect(
      h.db.prepare('SELECT folder_id FROM chat_folder_locations ORDER BY folder_id').all()
    ).toEqual([{ folder_id: 'child' }, { folder_id: 'parent' }])
    expect(h.db.prepare('SELECT parent_id FROM artifact_folders WHERE id=?').get('child')).toEqual({
      parent_id: 'parent'
    })
  } finally {
    h.cleanup()
  }
})

test('hub forwards drafts to original owner; reassignment cannot move history', async () => {
  const h = await createTestHarness(),
    dir = mkdtempSync(join(tmpdir(), 'chat-relay-'))
  const pc = createComputerChatRuntime({ stateDir: dir, hubScope: 'hub', computerId: 'pc-a' })
  try {
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db.prepare("INSERT INTO tasks(id,project_id,title) VALUES('task','p','Task')").run()
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0)"
      )
      .run()
    const ownership = createChatOwnershipStore(h.slayDb)
    await ownership.register({
      id: 'c',
      taskId: 'task',
      tabId: 'tab',
      mode: 'claude-chat',
      computerId: 'pc-a',
      epoch: 1
    })
    const request = vi.fn(async (computerId: string, p: unknown): Promise<unknown> => {
      expect(computerId).toBe('pc-a')
      const raw = p as { kind: string; value: unknown; id: string; operationId: string }
      if (raw.kind === 'bootstrap') {
        pc.bootstrap(raw.value as Parameters<typeof pc.bootstrap>[0])
        return { ok: true }
      }
      if (raw.kind === 'invoke') return pc.invoke(raw.value)
      if (raw.kind === 'pendingMetadata')
        return pc.storage
          .findRecords('settings')
          .filter((r) => r.id.startsWith('metadata:'))
          .map((r) => r.value)
      if (raw.kind === 'ackMetadata') {
        const owner = pc.storage.conversation(raw.id)!
        pc.storage.removeRecord(
          raw.id,
          owner.identity.epoch,
          'settings',
          `metadata:${raw.operationId}`
        )
        return { ok: true }
      }
      if (raw.kind === 'metadata.snapshot') return pc.local.metadataSnapshot(raw.id)
      if (raw.kind === 'inspect') return pc.storage.conversation(raw.id)
      throw new Error(raw.kind)
    })
    const gate = vi.fn(async () => {})
    const relay = createHubChatRelay({
      db: h.slayDb,
      ownership,
      request,
      resolveComputer: async () => 'pc-b',
      defaultComputer: async () => 'pc-a',
      gate,
      bootstrap: async (o) => ({
        identity: { id: o.id, taskId: o.taskId, tabId: o.tabId, mode: o.mode, epoch: o.epoch },
        projectId: 'p',
        cwd: '/project',
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }),
      migrate: async () => {
        throw new Error('Unexpected migration')
      }
    })
    await relay.invoke(
      'ops',
      'saveTabDraft',
      ['tab', { text: 'computer-only marker', attachments: [] }],
      'save-once'
    )
    await relay.invoke(
      'ops',
      'saveTabDraft',
      ['tab', { text: 'computer-only marker', attachments: [] }],
      'save-once'
    )
    expect(await relay.ops.getTabState('tab')).toMatchObject({
      draft: { text: 'computer-only marker', rev: 1 }
    })
    expect(h.db.prepare('SELECT count(*) AS n FROM chat_tab_state').get()).toEqual({ n: 0 })
    await pc.local.data.writeChatModel('task', 'claude-chat', 'old-model')
    await pc.local.data.writeChatModel('task', 'claude-chat', 'new-model')
    const oldUpdate = pc.storage
      .findRecords('settings')
      .find(
        (r) =>
          r.id.startsWith('metadata:') &&
          (r.value as { value: { value: unknown } }).value.value === 'old-model'
      )!.value as import('./local-data').ChatMetadataUpdate
    await relay.drainMetadata('pc-a')
    await relay.reconcileMetadata('pc-a', oldUpdate)
    const task = h.db.prepare('SELECT provider_config FROM tasks WHERE id=?').get('task') as {
      provider_config: string
    }
    expect(JSON.parse(task.provider_config)['claude-chat'].chatModel).toBe('new-model')
    h.db.prepare('DELETE FROM chat_metadata_progress').run()
    h.db.prepare("UPDATE tasks SET provider_config='{}'").run()
    await relay.drainMetadata('pc-a', true)
    expect(
      JSON.parse(
        (h.db.prepare('SELECT provider_config FROM tasks').get() as { provider_config: string })
          .provider_config
      )['claude-chat'].chatModel
    ).toBe('new-model')
    h.db.prepare('DELETE FROM chat_metadata_progress').run()
    await pc.local.data.writeChatModel('task', 'claude-chat', 'after-restore')
    await relay.drainMetadata('pc-a')
    expect(
      JSON.parse(
        (h.db.prepare('SELECT provider_config FROM tasks').get() as { provider_config: string })
          .provider_config
      )['claude-chat'].chatModel
    ).toBe('after-restore')
    expect(gate).toHaveBeenCalledWith('pc-a', 'task')
    expect((await ownership.forTab('tab'))?.computerId).toBe('pc-a')
    await expect(
      relay.invoke('ops', 'saveTabDraft', ['missing', { text: 'bad', attachments: [] }])
    ).rejects.toThrow(/tab/i)
  } finally {
    await pc.close()
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
