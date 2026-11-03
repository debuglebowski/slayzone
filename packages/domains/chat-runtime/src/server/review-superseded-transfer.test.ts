import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'
import { encodeTransfer } from './transfers'
import type { ChatMigrationSnapshot } from '../shared'

test('review: activation removes superseded pre-upgrade partial transfer payloads for its exact owner', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'review-superseded-transfer-'))
  const r = createComputerChatRuntime({ stateDir: root, hubScope: 'review', computerId: 'pc' })
  const snapshot: ChatMigrationSnapshot = {
    version: 1,
    migrationId: 'upgrade',
    hash: 'encodeTransfer recomputes this',
    identity: { id: 'chat', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
    events: [
      {
        seq: 0,
        at: 123,
        event: { kind: 'assistant-text', messageId: 'm', text: 'private copied history' }
      }
    ],
    records: [],
    receipts: []
  }
  try {
    const old = encodeTransfer(snapshot),
      partial = r.transfers.begin(old.manifest)
    r.transfers.chunk(partial.id, 0, old.bytes.subarray(0, old.bytes.length - 1))
    const upgraded = encodeTransfer({
      ...snapshot,
      records: [{ kind: 'settings', id: 'legacy-task-content-authority', value: false, at: 0 }]
    })
    const current = r.transfers.begin(upgraded.manifest)
    r.transfers.chunk(current.id, 0, upgraded.bytes)
    r.transfers.finish(current.id)
    r.transfers.collectActivated()
    expect(existsSync(join(r.storage.dir, 'transfers', partial.id + '.data'))).toBe(true)
    expect(existsSync(join(r.storage.dir, 'transfers', current.id + '.data'))).toBe(true)
    r.storage.activate('chat', 'upgrade', 2, upgraded.manifest.hash)
    r.transfers.collectActivated()
    expect(r.storage.read('chat', -1)[0].event).toMatchObject({ text: 'private copied history' })
    expect(existsSync(join(r.storage.dir, 'transfers', partial.id + '.data'))).toBe(false)
  } finally {
    await r.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('review: activation never erases partial transfer data outside its exact task/tab/mode/epoch/token lineage', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'review-transfer-scope-'))
  const r = createComputerChatRuntime({ stateDir: root, hubScope: 'review', computerId: 'pc' })
  const snapshot: ChatMigrationSnapshot = {
    version: 1,
    migrationId: 'current',
    hash: 'recomputed',
    identity: { id: 'chat', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
    events: [
      { seq: 0, at: 1, event: { kind: 'assistant-text', messageId: 'm', text: 'retained' } }
    ],
    records: [],
    receipts: []
  }
  try {
    const others = [
      { ...snapshot, identity: { ...snapshot.identity, id: 'another-owner' } },
      { ...snapshot, identity: { ...snapshot.identity, taskId: 'another-task' } },
      { ...snapshot, identity: { ...snapshot.identity, tabId: 'another-tab' } },
      { ...snapshot, identity: { ...snapshot.identity, mode: 'codex-chat' } },
      { ...snapshot, identity: { ...snapshot.identity, epoch: 2 } },
      { ...snapshot, migrationId: 'another-token' }
    ].map((other) => {
      const encoded = encodeTransfer(other),
        transfer = r.transfers.begin(encoded.manifest)
      r.transfers.chunk(transfer.id, 0, encoded.bytes.subarray(0, encoded.bytes.length - 1))
      return transfer.id
    })
    const current = encodeTransfer(snapshot),
      transfer = r.transfers.begin(current.manifest)
    r.transfers.chunk(transfer.id, 0, current.bytes)
    r.transfers.finish(transfer.id)
    r.storage.activate('chat', 'current', 2, current.manifest.hash)
    r.transfers.collectActivated()
    for (const id of others)
      expect(existsSync(join(r.storage.dir, 'transfers', id + '.data'))).toBe(true)
    expect(existsSync(join(r.storage.dir, 'transfers', transfer.id + '.data'))).toBe(false)
  } finally {
    await r.close()
    rmSync(root, { recursive: true, force: true })
  }
})
