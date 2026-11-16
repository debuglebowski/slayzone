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
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createComputerChatRuntime } from '@slayzone/chat-runtime/server'
import { createFileCredentialStore } from '@slayzone/computer-transport/client'
import { eraseComputerOffline as erase } from './offline-erasure'
import { createPtyHistory, ptyHistoryDir } from './pty-history'
const eraseComputerOffline = (
  root: string,
  request: unknown,
  options: { worktreesVerified?: boolean } = {}
) =>
  erase(root, request, { ...options, workerPath: resolve('packages/apps/computer/dist/bin.cjs') })

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
    const files: Record<string, string> = {}
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
    for (const taskId of ['alice', 'bob']) {
      const artifact = (await r.artifacts.invoke({
        route: { id: taskId, epoch: 1 },
        method: 'uploadArtifactBlob',
        args: [
          {
            taskId,
            title: `${taskId}.txt`,
            data: Buffer.from(`${taskId} original`).toString('base64')
          }
        ],
        operationId: `upload-${taskId}`
      })) as { id: string; title: string }
      const ref = await r.artifacts.seal(taskId, {
        artifactId: artifact.id,
        name: artifact.title,
        kind: 'text',
        mediaType: 'text/plain',
        size: `${taskId} original`.length
      })
      files[taskId] = ref.contentHash!
    }
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
    const backup = await r.backups.create('manual')
    const archive = await r.backups.restore(backup.id)
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
    // The production cleanup path must never execute native chat SQL on its host.
    // Its worker loads a separate native module, so this observes main only.
    const nativeMethods = ['prepare', 'exec', 'pragma', 'backup', 'close'] as const
    const mainSql = nativeMethods.map((method) => vi.spyOn(Database.prototype, method))
    let receipt: Awaited<ReturnType<typeof eraseComputerOffline>>
    try {
      receipt = await eraseComputerOffline(root, request)
      for (const method of mainSql) expect(method).not.toHaveBeenCalled()
    } finally {
      for (const method of mainSql) method.mockRestore()
    }
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
      expect(check.backups.conversations(archive.id).map((c) => c.taskId)).toContain('bob')
      expect(check.backups.conversations(archive.id).map((c) => c.taskId)).not.toContain('alice')
      expect(check.backups.list().some((b) => b.id === backup.id)).toBe(true)
      expect(existsSync(join(check.storage.dir, 'artifacts', 'alice'))).toBe(false)
      expect(existsSync(join(check.storage.dir, 'blobs', files.alice))).toBe(false)
      expect(existsSync(join(check.storage.dir, 'blobs', files.bob))).toBe(true)
      expect(readFileSync(check.storage.path).includes(Buffer.from('private Alice message'))).toBe(
        false
      )
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

test('packaged offline CLI erases through worker dispatch with every main-thread SQLite constructor refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'offline-erasure-packaged-'))
  try {
    await liveComputer(root)
    const requestFile = join(root, 'request.json')
    const receiptFile = join(root, 'receipt.json')
    const guard = join(root, 'forbid-main-sqlite.cjs')
    const attempted = join(root, 'main-sqlite-attempted')
    writeFileSync(requestFile, JSON.stringify(baseRequest))
    writeFileSync(
      guard,
      `
      const { isMainThread } = require('node:worker_threads')
      if (isMainThread) {
        const Module = require('node:module')
        const load = Module._load
        Module._load = function (name, ...args) {
          const value = load.call(this, name, ...args)
          if (name !== 'better-sqlite3') return value
          return new Proxy(value, {
            construct() {
              require('node:fs').writeFileSync(${JSON.stringify(attempted)}, 'refused')
              throw new Error('Native SQLite constructor ran on computer main')
            }
          })
        }
      }
    `
    )
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--require',
        guard,
        resolve('packages/apps/computer/dist/bin.cjs'),
        '--erase-data',
        requestFile,
        '--receipt',
        receiptFile
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SLAYZONE_ROOT: root } }
    )
    expect(stdout.match(/Cleanup receipt saved/g)).toHaveLength(1)
    expect(existsSync(attempted)).toBe(false)
    expect(JSON.parse(readFileSync(receiptFile, 'utf8'))).toMatchObject({
      managedContentErased: true
    })
    const check = createComputerChatRuntime({
      stateDir: root,
      hubScope: 'hub.example',
      computerId: 'pc',
      maintenance: true
    })
    try {
      expect(check.storage.taskLifecycle('alice')).toMatchObject({ state: 'deleted', revision: 2 })
      expect(check.storage.taskLifecycle('bob').state).toBe('active')
    } finally {
      await check.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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

test('torn hook journals never block offline cleanup; their quarantined bytes naming the task are erased', async () => {
  const root = mkdtempSync(join(tmpdir(), 'offline-erasure-torn-'))
  try {
    await liveComputer(root)
    const runtime = join(root, 'computer-runtime')
    const hook = (taskId: string) => ({
      id: `hook-${taskId}`,
      params: { name: 'agent-hook', payload: { taskId, text: `private ${taskId} hook` } }
    })
    // Another hub's journal, torn, holding none of the erased tasks.
    writeFileSync(join(runtime, `hooks-${'b'.repeat(16)}.json`), '[{"id":"x","params":{"pay')
    // This hub's journal, torn after alice's and bob's events.
    const own = hookJournalPath(runtime, baseRequest.hubUrl)
    writeFileSync(own, JSON.stringify([hook('alice'), hook('bob')]).slice(0, -3))
    const receipt = await eraseComputerOffline(root, baseRequest)
    expect(receipt.managedContentErased).toBe(true)
    const left = readFileSync(own, 'utf8')
    expect(left).not.toContain('private alice hook')
    // No quarantined copy of alice's hook survives the erasure.
    const quarantine = join(runtime, 'quarantine')
    const remaining = existsSync(quarantine)
      ? readdirSync(quarantine, { recursive: true, withFileTypes: true })
          .filter((d) => d.isFile() && d.name === 'payload')
          .map((d) => readFileSync(join(d.parentPath, d.name), 'utf8'))
      : []
    expect(remaining.some((text) => text.includes('private alice hook'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
