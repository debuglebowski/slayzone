import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness'
import { createComputerChatRuntime } from './computer-runtime'
import { createChatOwnershipStore } from './hub-ownership'
import { createHubChatRelay } from './hub-relay'

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
      const raw = p as { kind: string; value: any; id: string; operationId: string }
      if (raw.kind === 'bootstrap') {
        pc.bootstrap(raw.value)
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
      .find((r) => r.id.startsWith('metadata:') && (r.value as any).value.value === 'old-model')!
      .value as import('./local-data').ChatMetadataUpdate
    await relay.drainMetadata('pc-a')
    await relay.reconcileMetadata('pc-a', oldUpdate)
    const task = h.db.prepare('SELECT provider_config FROM tasks WHERE id=?').get('task') as {
      provider_config: string
    }
    expect(JSON.parse(task.provider_config)['claude-chat'].chatModel).toBe('new-model')
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
