import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { createComputerChatRuntime } from '@slayzone/chat-runtime/server'
import { createFileCredentialStore } from '@slayzone/computer-transport/client'
import { eraseComputerOffline } from './offline-erasure'
test('a revoked/offline computer erases only the issued hub/task scope and returns non-content evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'offline-erasure-'))
  const r = createComputerChatRuntime({ stateDir: root, hubScope: 'hub.example', computerId: 'pc' })
  try {
    for (const taskId of ['alice', 'bob'])
      r.bootstrap({
        identity: { id: taskId, taskId, tabId: taskId, mode: 'claude-chat', epoch: 1 },
        projectId: null,
        cwd: root,
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      })
    r.storage.append(
      'alice',
      1,
      { kind: 'assistant-text', messageId: 'a', text: 'private Alice message' },
      1
    )
    r.storage.append(
      'bob',
      1,
      { kind: 'assistant-text', messageId: 'b', text: 'private Bob message' },
      1
    )
    await r.close()
    await createFileCredentialStore('hub.example', { baseDir: root }).save({
      computerId: 'pc',
      apiKey: 'disposable fixture credential'
    })
    const history = join(
      root,
      'computer-runtime',
      'pty-history',
      createHash('sha256').update('hub.example').digest('hex'),
      'alice'
    )
    mkdirSync(history, { recursive: true })
    writeFileSync(join(history, 'output.txt'), 'private terminal scrollback')
    const request = {
      version: 1 as const,
      requestId: '11111111-1111-4111-8111-111111111111',
      jobId: '22222222-2222-4222-8222-222222222222',
      computerId: 'pc',
      hubUrl: 'wss://hub.example/computers',
      hubScope: 'hub.example',
      tasks: [{ taskId: 'alice', revision: 2 }],
      worktreeTaskIds: []
    }
    await expect(eraseComputerOffline(root, { ...request, computerId: 'wrong' })).rejects.toThrow(
      /identity/
    )
    const receipt = await eraseComputerOffline(root, request)
    expect(receipt.managedContentErased).toBe(true)
    expect(JSON.stringify(receipt)).not.toContain('private')
    expect(existsSync(history)).toBe(false)
    const check = createComputerChatRuntime({
      stateDir: root,
      hubScope: 'hub.example',
      computerId: 'pc'
    })
    try {
      expect(check.storage.read('alice', -1)).toEqual([])
      expect(check.storage.read('bob', -1)).toHaveLength(1)
    } finally {
      await check.close()
    }
  } finally {
    await r.close()
    rmSync(root, { recursive: true, force: true })
  }
})
