import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createComputerChatRuntime } from './computer-runtime'
// Fails the test on a lifecycle model / runtime disagreement.
import '../../../terminal/src/server/runtime/chat-lifecycle-strict-testkit'

test('computer erasure verifies local history, originals and sealed files while preserving another task', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'computer-erasure-'))
  let r = createComputerChatRuntime({ stateDir, hubScope: 'hub', computerId: 'pc' })
  try {
    const files: Record<string, { id: string; hash: string }> = {}
    for (const taskId of ['alice', 'bob']) {
      r.bootstrap({
        identity: { id: taskId, taskId, tabId: taskId, mode: 'claude-chat', epoch: 1 },
        projectId: null,
        cwd: stateDir,
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      })
      const bytes = Buffer.from(`${taskId} private original`)
      const a = (await r.artifacts.invoke({
        route: { id: taskId, epoch: 1 },
        method: 'uploadArtifactBlob',
        args: [{ taskId, title: 'private.txt', data: bytes.toString('base64') }],
        operationId: `upload-${taskId}`
      })) as { id: string; title: string }
      const ref = await r.artifacts.seal(taskId, {
        artifactId: a.id,
        name: a.title,
        kind: 'text',
        mediaType: 'text/plain',
        size: bytes.length
      })
      files[taskId] = { id: a.id, hash: ref.contentHash! }
      r.storage.append(
        taskId,
        1,
        { kind: 'assistant-text', messageId: taskId, text: `${taskId} secret` },
        Date.now()
      )
    }
    const backup = await r.backups.create('manual')
    const archive = await r.backups.restore(backup.id)
    const lease = r.storage.acquireBlobLease('test', 60000)
    // The normal lifecycle push can arrive before the verified erase request.
    await r.applyTaskLifecycle('alice', 'deleted', 2)
    await expect(r.eraseTask('alice', 2)).rejects.toThrow(/lease|backup/i)
    lease.release()
    await r.close()
    r = createComputerChatRuntime({ stateDir, hubScope: 'hub', computerId: 'pc' })
    const vacuums = countVacuums(r)
    expect(await r.eraseTask('alice', 2)).toEqual({ taskId: 'alice', revision: 2, erased: true })
    // Rewritten off the main thread (no VACUUM there), done before erasure reported done.
    expect(vacuums()).toBe(0)
    expect(r.storage.maintenance.fileStats().autoVacuum).toBe(2)
    expect(storeFilesHolding(stateDir, 'alice secret')).toEqual([])
    expect(existsSync(join(r.storage.dir, 'artifacts', 'alice'))).toBe(false)
    expect(existsSync(join(r.storage.dir, 'blobs', files.alice.hash))).toBe(false)
    expect(r.storage.read('alice', -1)).toEqual([])
    expect(r.storage.read('bob', -1)).toHaveLength(1)
    expect((await r.backups.conversations(archive.id)).some((c) => c.taskId === 'alice')).toBe(
      false
    )
    expect((await r.backups.conversations(archive.id)).some((c) => c.taskId === 'bob')).toBe(true)
    expect(r.backups.list().some((b) => b.id === backup.id)).toBe(true)
    expect(
      readFileSync(join(r.storage.dir, 'chat.sqlite')).includes(Buffer.from('alice secret'))
    ).toBe(false)
    expect(() =>
      r.storage.append(
        'alice',
        1,
        { kind: 'assistant-text', messageId: 'late', text: 'late secret' },
        Date.now()
      )
    ).toThrow()
  } finally {
    await r.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})

/** Counts VACUUMs run on the store's own connection (the main thread). */
function countVacuums(r: ReturnType<typeof createComputerChatRuntime>) {
  let n = 0
  r.storage.compose((db) => {
    const exec = db.exec.bind(db)
    db.exec = ((sql: string) => {
      if (/^\s*VACUUM\b/i.test(sql)) n++
      return exec(sql)
    }) as typeof db.exec
  })
  return () => n
}
/**
 * SQLite files (live store, WAL, restored archives) under `root` that still hold `text`.
 * Backups are skipped: they keep content erased later, by design (Settings says so).
 */
function storeFilesHolding(root: string, text: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'backups') walk(path)
      } else if (/chat\.sqlite/.test(entry.name) && readFileSync(path).includes(Buffer.from(text)))
        found.push(path)
    }
  }
  walk(root)
  return found
}

test('concurrent erasures share one off-thread rewrite; a user compaction waits for it', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'computer-erasure-'))
  let entered!: () => void
  const rewriteStarted = new Promise<void>((resolve) => {
    entered = resolve
  })
  let both: Promise<unknown> | undefined
  const r = createComputerChatRuntime({
    stateDir,
    hubScope: 'hub',
    computerId: 'pc',
    blobBackfill: { automatic: false },
    compaction: {
      onPhase: (phase) => {
        if (phase === 'worker-started') entered()
      }
    }
  })
  try {
    for (const taskId of ['alice', 'bob', 'carol']) {
      r.bootstrap({
        identity: { id: taskId, taskId, tabId: taskId, mode: 'claude-chat', epoch: 1 },
        projectId: null,
        cwd: stateDir,
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      })
      r.storage.transaction(() => {
        for (let i = 0; i < 20; i++)
          r.storage.append(
            taskId,
            1,
            {
              kind: 'assistant-text',
              messageId: `${taskId}-${i}`,
              text: `${taskId} secret ${'x'.repeat(50_000)}`
            },
            Date.now()
          )
      })
    }
    await r.applyTaskLifecycle('alice', 'deleted', 2)
    await r.applyTaskLifecycle('bob', 'deleted', 2)
    const vacuums = countVacuums(r)
    both = Promise.all([r.eraseTask('alice', 2), r.eraseTask('bob', 2)])
    void both.catch(() => undefined)
    // Owned staging drains asynchronously before the existing off-thread rewrite.
    await rewriteStarted
    expect(() => r.compaction.start()).toThrow(/erasure/i)
    expect(await both).toEqual([
      { taskId: 'alice', revision: 2, erased: true },
      { taskId: 'bob', revision: 2, erased: true }
    ])
    expect(vacuums()).toBe(0)
    expect(storeFilesHolding(stateDir, 'alice secret')).toEqual([])
    expect(storeFilesHolding(stateDir, 'bob secret')).toEqual([])
    expect(r.storage.read('carol', -1)).toHaveLength(20)
  } finally {
    await both?.catch(() => undefined)
    await r.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
