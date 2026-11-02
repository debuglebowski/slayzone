import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import { artifactsTxns } from '@slayzone/task-artifacts/db'
import { createComputerChatRuntime } from './computer-runtime'
import { captureArtifactWorkingFiles } from './artifact-backup'

const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
const identity = {
  id: 'files',
  taskId: 'task',
  tabId: 'artifact-store:task:pc',
  mode: 'claude-chat',
  epoch: 1
}
test.each(['pruned', 'external'] as const)(
  'backup preserves and exposes the %s working original without creating live versions',
  async (kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-original-backup-'))
    const r = createComputerChatRuntime({ stateDir: dir, hubScope: 'audit', computerId: 'pc' })
    let resumeCopy = () => {},
      ready = () => {}
    const snapshotReady = new Promise<void>((resolve) => {
      ready = resolve
    })
    const copyAllowed = new Promise<void>((resolve) => {
      resumeCopy = resolve
    })
    let backupWork: ReturnType<typeof r.backups.create> | undefined
    try {
      r.bootstrap({
        identity,
        projectId: null,
        cwd: dir,
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      })
      const route = { id: identity.id, epoch: 1 }
      const artifact = (await r.artifacts.invoke({
        route,
        method: 'uploadArtifactBlob',
        operationId: randomUUID(),
        args: [
          {
            taskId: 'task',
            title: 'original.txt',
            data: Buffer.from('saved version').toString('base64')
          }
        ]
      })) as { id: string }
      const original = kind === 'pruned' ? 'saved version' : 'external unsaved working bytes'
      if (kind === 'pruned')
        await r.artifacts.invoke({
          route,
          method: 'pruneArtifactVersions',
          operationId: randomUUID(),
          args: [{ artifactId: artifact.id, keepCurrent: false, keepNamed: false, keepLast: 0 }]
        })
      else
        writeFileSync(
          (await r.artifacts.store.getArtifactPath(r.artifacts.db, artifact.id))!,
          original
        )
      const beforeVersions = await r.artifacts.invoke({
        route,
        method: 'listArtifactVersions',
        args: [{ artifactId: artifact.id }]
      })
      const backupTo = r.storage.backupTo.bind(r.storage)
      vi.spyOn(r.storage, 'backupTo').mockImplementation(async (target) => {
        const result = await backupTo(target)
        ready()
        await copyAllowed
        return result
      })
      backupWork = r.backups.create('manual')
      await Promise.race([snapshotReady, backupWork])
      expect(
        await r.artifacts.invoke({
          route,
          method: 'listArtifactVersions',
          args: [{ artifactId: artifact.id }]
        })
      ).toEqual(beforeVersions)
      writeFileSync(
        (await r.artifacts.store.getArtifactPath(r.artifacts.db, artifact.id))!,
        'changed after snapshot'
      )
      await r.applyTaskLifecycle('task', 'deleted', 1)
      resumeCopy()
      const backup = await backupWork
      const archive = await r.backups.restore(backup.id)
      expect(
        r.backups.file(archive.id, identity.id, artifact.id, sha(original)).data.toString()
      ).toBe(original)
      expect(r.backups.records(archive.id, identity.id).records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'artifact-original',
            value: expect.objectContaining({ artifactId: artifact.id, contentHash: sha(original) })
          })
        ])
      )
    } finally {
      resumeCopy()
      await backupWork?.catch(() => {})
      vi.restoreAllMocks()
      await r.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test('working-original capture rejects an artifact revision absent from its snapshot proof', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-original-snapshot-race-'))
  const r = createComputerChatRuntime({ stateDir: dir, hubScope: 'audit', computerId: 'pc' })
  let captured: Awaited<ReturnType<typeof captureArtifactWorkingFiles>> | undefined
  let db: Database.Database | undefined
  try {
    r.bootstrap({
      identity,
      projectId: null,
      cwd: dir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    const route = { id: identity.id, epoch: 1 }
    const artifact = (await r.artifacts.invoke({
      route,
      method: 'uploadArtifactBlob',
      operationId: randomUUID(),
      args: [
        { taskId: 'task', title: 'file.txt', data: Buffer.from('captured A').toString('base64') }
      ]
    })) as { id: string }
    captured = await captureArtifactWorkingFiles(r.storage, join(dir, 'staging'))
    await r.artifacts.invoke({
      route,
      method: 'updateArtifact',
      operationId: randomUUID(),
      args: [{ id: artifact.id, content: 'new committed B' }]
    })
    const snapshot = join(dir, 'snapshot.sqlite')
    await r.storage.backupTo(snapshot)
    db = new Database(snapshot)
    expect(() => captured!.apply(db!)).toThrow(/changed.*snapshot|retry/i)
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='artifact_working_files'").get()
    ).toBeUndefined()
  } finally {
    db?.close()
    captured?.dispose()
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backup immediately after prune rollback restores quarantined historical bytes without a prior read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-original-rollback-backup-'))
  const r = createComputerChatRuntime({ stateDir: dir, hubScope: 'audit', computerId: 'pc' })
  try {
    r.bootstrap({
      identity,
      projectId: null,
      cwd: dir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    const route = { id: identity.id, epoch: 1 }
    const artifact = (await r.artifacts.invoke({
      route,
      method: 'uploadArtifactBlob',
      operationId: randomUUID(),
      args: [{ taskId: 'task', title: 'file.txt', data: Buffer.from('A').toString('base64') }]
    })) as { id: string }
    for (const content of ['B', 'C'])
      await r.artifacts.invoke({
        route,
        method: 'updateArtifact',
        operationId: randomUUID(),
        args: [{ id: artifact.id, content }]
      })
    expect(() =>
      r.storage.compose((raw) =>
        raw.transaction(() => {
          artifactsTxns['task-artifacts:versions:prune'](raw, {
            dataDir: r.storage.dir,
            artifactId: artifact.id,
            keepLast: 1
          })
          throw new Error('outer rollback')
        })()
      )
    ).toThrow('outer rollback')
    const backup = await r.backups.create('manual')
    await r.applyTaskLifecycle('task', 'deleted', 1)
    const archive = await r.backups.restore(backup.id)
    for (const content of ['A', 'B', 'C'])
      expect(
        r.backups.file(archive.id, identity.id, artifact.id, sha(content)).data.toString()
      ).toBe(content)
  } finally {
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test.each(['v2-missing-working', 'v1-version-only'] as const)(
  'archive validates %s compatibility and working-original completeness',
  async (format) => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-backup-format-compatibility-'))
    const r = createComputerChatRuntime({ stateDir: dir, hubScope: 'audit', computerId: 'pc' })
    try {
      r.bootstrap({
        identity,
        projectId: null,
        cwd: dir,
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      })
      const route = { id: identity.id, epoch: 1 },
        content = 'version-only legacy bytes'
      const artifact = (await r.artifacts.invoke({
        route,
        method: 'uploadArtifactBlob',
        operationId: randomUUID(),
        args: [
          { taskId: 'task', title: 'legacy.txt', data: Buffer.from(content).toString('base64') }
        ]
      })) as { id: string }
      if (format === 'v2-missing-working')
        await r.artifacts.invoke({
          route,
          method: 'pruneArtifactVersions',
          operationId: randomUUID(),
          args: [{ artifactId: artifact.id, keepCurrent: false, keepNamed: false, keepLast: 0 }]
        })
      const backup = await r.backups.create('manual')
      const database = join(r.backups.dir, backup.id, 'chat.sqlite'),
        manifestFile = join(r.backups.dir, backup.id, 'manifest.json')
      const db = new Database(database)
      try {
        db.exec('DROP TABLE artifact_working_files')
        if (format === 'v1-version-only')
          db.exec(
            'DROP TABLE IF EXISTS provider_configs; DROP TABLE IF EXISTS storage_maintenance; DROP TABLE IF EXISTS artifact_file_commits; PRAGMA user_version=3'
          )
      } finally {
        db.close()
      }
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
      const bytes = readFileSync(database),
        entry = manifest.files.find((file: { path: string }) => file.path === 'chat.sqlite')
      entry.hash = createHash('sha256').update(bytes).digest('hex')
      entry.size = bytes.length
      manifest.backup.sizeBytes = manifest.files.reduce(
        (size: number, file: { size: number }) => size + file.size,
        0
      )
      if (format === 'v1-version-only') {
        manifest.version = 1
        delete manifest.artifactFiles
        delete manifest.workingFiles
        delete manifest.backup.deferredConversations
      }
      writeFileSync(manifestFile, JSON.stringify(manifest))
      if (format === 'v2-missing-working') {
        await expect(r.backups.restore(backup.id)).rejects.toThrow(
          /working|incomplete|artifact|count/i
        )
        expect(r.backups.listArchives()).toEqual([])
      } else {
        const archive = await r.backups.restore(backup.id)
        expect(
          r.backups.file(archive.id, identity.id, artifact.id, sha(content)).data.toString()
        ).toBe(content)
        const records = r.backups.records(archive.id, identity.id).records
        expect(records.filter((record) => record.kind === 'artifact-version')).toHaveLength(1)
        expect(records.filter((record) => record.kind === 'artifact-original')).toEqual([])
      }
    } finally {
      await r.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

test('concurrent manual backups preserve identical originals without racing their private snapshot links', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-backup-concurrent-originals-'))
  const r = createComputerChatRuntime({ stateDir: dir, hubScope: 'audit', computerId: 'pc' })
  try {
    r.bootstrap({
      identity,
      projectId: null,
      cwd: dir,
      revision: 1,
      providerConfig: {},
      defaultFlags: null,
      env: {}
    })
    const route = { id: identity.id, epoch: 1 },
      content = 'concurrent backup original'
    const artifact = (await r.artifacts.invoke({
      route,
      method: 'uploadArtifactBlob',
      operationId: randomUUID(),
      args: [{ taskId: 'task', title: 'file.txt', data: Buffer.from(content).toString('base64') }]
    })) as { id: string }
    const backups = await Promise.all([r.backups.create('manual'), r.backups.create('manual')])
    expect(new Set(backups.map((backup) => backup.id)).size).toBe(2)
    for (const backup of backups) {
      const archive = await r.backups.restore(backup.id)
      expect(
        r.backups.file(archive.id, identity.id, artifact.id, sha(content)).data.toString()
      ).toBe(content)
    }
  } finally {
    await r.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
