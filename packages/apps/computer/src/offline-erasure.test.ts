import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, test } from 'vitest'
import { createComputerChatRuntime } from '@slayzone/chat-runtime/server'
import { createFileCredentialStore } from '@slayzone/computer-transport/client'
import { eraseComputerOffline } from './offline-erasure'
import { createPtyHistory, ptyHistoryDir } from './pty-history'
import { adoptHookJournal, hookJournalPath } from './hook-journal'

test.skipIf(process.platform === 'win32')(
  'offline cleanup refuses a surviving process group after its leader exits',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'offline-erasure-process-'))
    const leader = spawn('sh', ['-c', 'sleep 120 & exit 0'], {
      detached: true,
      stdio: 'ignore',
      cwd: root
    })
    const pgid = leader.pid!
    try {
      await once(leader, 'exit')
      expect(() => process.kill(-pgid, 0)).not.toThrow()
      await createFileCredentialStore('hub.example', { baseDir: root }).save({
        computerId: 'pc',
        apiKey: 'fixture'
      })
      const runtime = join(root, 'computer-runtime')
      mkdirSync(runtime, { recursive: true })
      writeFileSync(join(runtime, 'proc-groups.json'), JSON.stringify({ groups: [{ pgid }] }))
      await expect(
        eraseComputerOffline(root, {
          version: 1,
          requestId: '11111111-1111-4111-8111-111111111111',
          jobId: '22222222-2222-4222-8222-222222222222',
          computerId: 'pc',
          hubUrl: 'wss://hub.example/computers',
          hubScope: 'hub.example',
          tasks: [{ taskId: 'alice', revision: 2 }],
          worktreeTaskIds: []
        })
      ).rejects.toThrow(/process is still running/)
    } finally {
      try {
        process.kill(-pgid, 'SIGKILL')
      } catch {
        /* Already stopped. */
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
)

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

/** A computer's state dir as a live host leaves it: chat for alice + bob, a credential. */
async function liveComputer(root: string) {
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
  } finally {
    await r.close()
  }
  await createFileCredentialStore('hub.example', { baseDir: root }).save({
    computerId: 'pc',
    apiKey: 'disposable fixture credential'
  })
}
const baseRequest = {
  version: 1 as const,
  requestId: '11111111-1111-4111-8111-111111111111',
  jobId: '22222222-2222-4222-8222-222222222222',
  computerId: 'pc',
  hubUrl: 'wss://hub.example/computers',
  hubScope: 'hub.example',
  tasks: [{ taskId: 'alice', revision: 2 }],
  worktreeTaskIds: []
}

test('terminal history is erased where the live computer writes it, temp files included', async () => {
  const root = mkdtempSync(join(tmpdir(), 'offline-erasure-history-'))
  try {
    await liveComputer(root)
    // The dir the live computer writes (main.ts builds it with this same helper)…
    const dir = ptyHistoryDir(root, 'hub.example')
    // …and its on-disk layout, pinned: a change would orphan every computer's history.
    expect(dir).toBe(
      join(
        root,
        'computer-runtime',
        'pty-history',
        createHash('sha256').update('hub.example').digest('hex').slice(0, 24)
      )
    )
    const history = createPtyHistory({ dir })
    const source = {
      toString: () => 'private terminal scrollback',
      getChunksSince: () => [],
      getCurrentSeq: () => 1
    }
    for (const taskId of ['alice', 'bob']) {
      const tracker = history.track(taskId, 'session-1', source)!
      tracker.flushSync()
      await tracker.cancel()
    }
    const aliceDir = join(dir, 'alice')
    const [saved] = readdirSync(aliceDir)
    expect(saved).toMatch(/\.txt$/)
    // A whole write a crash interrupted (pty-history.ts `<file>.<pid>.<n>.tmp`).
    writeFileSync(join(aliceDir, `${saved}.4242.7.tmp`), 'private partial scrollback')
    const receipt = await eraseComputerOffline(root, baseRequest)
    expect(receipt.managedContentErased).toBe(true)
    expect(existsSync(aliceDir)).toBe(false)
    expect(history.load('alice', 'session-1')).toBe(null)
    expect(history.load('bob', 'session-1')).toBe('private terminal scrollback')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a hook journal under another spelling of the hub URL is never reported erased', async () => {
  const root = mkdtempSync(join(tmpdir(), 'offline-erasure-journal-'))
  try {
    await liveComputer(root)
    const configured = 'wss://hub.example/computers/'
    // As a host that has not run since this change left it: named by the raw URL.
    const journal = join(
      root,
      'computer-runtime',
      'hooks-' + createHash('sha256').update(configured).digest('hex').slice(0, 16) + '.json'
    )
    const hook = (taskId: string) => ({
      id: `hook-${taskId}`,
      params: { name: 'agent-hook', payload: { taskId, text: `private ${taskId} hook` } }
    })
    writeFileSync(journal, JSON.stringify([hook('alice'), hook('bob')]))
    // The admin typed the canonical spelling: it passes the hub check, so it must not
    // pass the journal silently.
    await expect(eraseComputerOffline(root, baseRequest)).rejects.toThrow(/hook/i)
    expect(readFileSync(journal, 'utf8')).toContain('private alice hook')
    const receipt = await eraseComputerOffline(root, { ...baseRequest, hubUrl: configured })
    expect(receipt.managedContentErased).toBe(true)
    const left = readFileSync(journal, 'utf8')
    expect(left).not.toContain('private alice hook')
    expect(left).toContain('private bob hook')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a host renames a journal kept under another spelling, so any spelling then reaches it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'offline-erasure-adopt-'))
  try {
    await liveComputer(root)
    const runtime = join(root, 'computer-runtime')
    const configured = 'WSS://Hub.Example:443/computers/'
    const legacy = join(
      runtime,
      'hooks-' + createHash('sha256').update(configured).digest('hex').slice(0, 16) + '.json'
    )
    const hook = (taskId: string) => ({
      id: `hook-${taskId}`,
      params: { name: 'agent-hook', payload: { taskId, text: `private ${taskId} hook` } }
    })
    writeFileSync(legacy, JSON.stringify([hook('alice'), hook('bob')]))
    // What SessionTransport does at start.
    const journal = adoptHookJournal(runtime, configured)
    expect(journal).toBe(hookJournalPath(runtime, 'wss://hub.example/computers'))
    expect(existsSync(legacy)).toBe(false)
    // An unpublished write a crash left, from a writer that is gone.
    writeFileSync(`${journal}.999999999.abcdef01.tmp`, JSON.stringify([hook('alice')]))
    const receipt = await eraseComputerOffline(root, baseRequest)
    expect(receipt.managedContentErased).toBe(true)
    const left = readFileSync(journal, 'utf8')
    expect(left).not.toContain('private alice hook')
    expect(left).toContain('private bob hook')
    expect(readdirSync(runtime).filter((f) => f.endsWith('.tmp'))).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('adopting merges a journal both an older and a newer host wrote, by event id', () => {
  const runtime = mkdtempSync(join(tmpdir(), 'hook-journal-merge-'))
  try {
    const url = 'wss://hub.example/computers/'
    const event = (id: string) => ({ id, params: { name: 'agent-hook', payload: { id } } })
    writeFileSync(hookJournalPath(runtime, url), JSON.stringify([event('a'), event('b')]))
    const legacy = join(
      runtime,
      'hooks-' + createHash('sha256').update(url).digest('hex').slice(0, 16) + '.json'
    )
    writeFileSync(legacy, JSON.stringify([event('b'), event('c')]))
    const journal = adoptHookJournal(runtime, url)
    expect(JSON.parse(readFileSync(journal, 'utf8')).map((e: { id: string }) => e.id)).toEqual([
      'a',
      'b',
      'c'
    ])
    expect(readdirSync(runtime)).toEqual([journal.slice(runtime.length + 1)])
    // A canonical spelling names its file as it always did: nothing moves.
    expect(hookJournalPath(runtime, 'wss://hub.example/computers')).toBe(
      join(
        runtime,
        'hooks-' +
          createHash('sha256').update('wss://hub.example/computers').digest('hex').slice(0, 16) +
          '.json'
      )
    )
  } finally {
    rmSync(runtime, { recursive: true, force: true })
  }
})
