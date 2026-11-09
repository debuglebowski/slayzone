import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { SlayzoneDb } from '@slayzone/platform'
import { assertPathSafeId, containedPath } from '@slayzone/platform/safe-path'
import type { ErasureReceipt, ErasureReport, ErasureScope } from '../shared'
import type { ErasureJob, ErasureManifest } from './manifest'
import type {} from './worker-db'
import { hasUnattributedFiles } from './inventory'
import { currentSecurityContext, securityEvent } from '@slayzone/platform/security-log'

export interface ErasureOptions {
  actorUserId?: string | null
  beforeDelete?: (taskIds: string[]) => void | Promise<void>
  removePath?: (path: string) => void
  beforeResume?: (scope: ErasureScope) => void | Promise<void>
  onProgress?: (report: ErasureReport) => void
  cleanupWorktree?: (target: ErasureManifest['worktrees'][number]) => Promise<void>
  cleanupAdditionalStores?: (target: {
    jobId: string
    taskIds: string[]
    projectIds: string[]
    verifyOwnership: boolean
  }) => Promise<void>
  cleanupComputer?: (request: { jobId: string; computerId: string; taskIds: string[] }) => Promise<
    Array<{
      taskId: string
      revision: number
      erased: true
    }>
  >
}

const configured = new WeakMap<SlayzoneDb, ErasureOptions>()
export function configureContentErasure(db: SlayzoneDb, options: ErasureOptions): void {
  configured.set(db, options)
}

export function startErasureRetries(db: SlayzoneDb, root: string) {
  let stopped = false,
    pending: Promise<void> | null = null
  function retry(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      const jobs = await db.all<{ id: string }>(
        "SELECT id FROM content_erasure_jobs WHERE state='incomplete' ORDER BY created_at"
      )
      for (const job of jobs) {
        if (stopped) break
        try {
          await resumeErasure(db, root, job.id)
        } catch {
          /* Durable intent survives until the next retry. */
        }
      }
    })().finally(() => {
      pending = null
    })
    return pending
  }
  const timer = setInterval(() => {
    void retry().catch(() => undefined)
  }, 30_000)
  timer.unref()
  void retry().catch(() => undefined)
  return {
    retry,
    async close() {
      stopped = true
      clearInterval(timer)
      await pending
      await Promise.allSettled([...(running.get(db)?.values() ?? [])])
    }
  }
}

function syncDirectory(path: string) {
  if (process.platform === 'win32' || !existsSync(path)) return
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

async function jobOf(db: SlayzoneDb, id: string): Promise<ErasureJob> {
  const job = await db.get<ErasureJob>('SELECT * FROM content_erasure_jobs WHERE id=?', [id])
  if (!job) throw new Error('ERASURE_NOT_FOUND')
  return job
}

/** Public metadata only: never serialize the internal cleanup manifest. */
export async function getErasureReport(db: SlayzoneDb, id: string): Promise<ErasureReport> {
  const job = await jobOf(db, id),
    m = JSON.parse(job.manifest) as ErasureManifest
  const computers: ErasureReport['computers'] = []
  for (const target of m.computers) {
    const computer = await db.get<{ name: string }>('SELECT name FROM computers WHERE id=?', [
      target.id
    ])
    let deleted = true,
      operator = false
    for (const taskId of target.taskIds) {
      const ack = await db.get<{ method: 'computer' | 'operator' }>(
        `SELECT a.method FROM content_erasure_computer_acks a
        JOIN chat_task_lifecycle l ON l.task_id=a.task_id
        WHERE a.job_id=? AND a.computer_id=? AND a.task_id=? AND l.state='deleted' AND a.revision>=l.revision`,
        [id, target.id, taskId]
      )
      if (!ack) deleted = false
      if (ack?.method === 'operator') operator = true
    }
    if (m.worktrees.some((w) => w.computerId === target.id && !w.deleted)) deleted = false
    computers.push({
      id: target.id,
      name: computer?.name ?? `Computer ${target.id.slice(0, 8)}`,
      deleted,
      ...(deleted ? { verifiedBy: operator ? ('operator' as const) : ('computer' as const) } : {})
    })
  }
  for (const dependency of m.dependencies) {
    const previous = await getErasureReport(db, dependency)
    for (const computer of previous.computers) {
      const existing = computers.find((c) => c.id === computer.id)
      if (existing) existing.deleted = existing.deleted && computer.deleted
      else computers.push(computer)
    }
  }
  return {
    id,
    state: job.state,
    counts: m.counts,
    computers,
    failures: JSON.parse(job.failure_codes) as string[],
    retainedSharedBlobs: job.retained_shared_blobs,
    retainedBackupBlobs: job.retained_backup_blobs
  }
}

function cleanupFiles(root: string, m: ErasureManifest, remove: (path: string) => void) {
  const erase = (file: string) => {
    remove(file)
    if (existsSync(file)) throw new Error('FILE_REMAINS')
    syncDirectory(dirname(file))
  }
  for (const taskId of m.taskIds) {
    assertPathSafeId(taskId, 'taskId')
    for (const directory of ['artifacts', 'assets'])
      erase(containedPath(join(root, directory), taskId))
  }
  if (m.scope.kind === 'artifacts') {
    for (const original of m.artifactTasks) {
      assertPathSafeId(original.artifactId, 'artifactId')
      for (const directory of ['artifacts', 'assets']) {
        const taskDir = containedPath(
          join(root, directory),
          assertPathSafeId(original.taskId, 'taskId')
        )
        if (existsSync(taskDir))
          for (const entry of readdirSync(taskDir)) {
            // Artifact IDs cannot contain '.', so this cannot match another ID.
            if (entry === original.artifactId || entry.startsWith(original.artifactId + '.'))
              erase(containedPath(taskDir, entry))
          }
      }
    }
  }
  for (const projectId of m.projectIds) {
    assertPathSafeId(projectId, 'projectId')
    for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'])
      erase(containedPath(join(root, 'project-icons'), `${projectId}.${extension}`))
  }
  // Before/after images may survive a crash independently of working originals.
  const journalRoot = join(root, 'artifacts', '.transactions')
  if (existsSync(journalRoot))
    for (const entry of readdirSync(journalRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const journal = containedPath(journalRoot, assertPathSafeId(entry.name, 'journalId'))
      const manifest = join(journal, 'manifest.json')
      if (!existsSync(manifest)) continue
      const change = JSON.parse(readFileSync(manifest, 'utf8')) as {
        taskId?: string
        artifactId?: string
      }
      if (
        m.taskIds.includes(change.taskId ?? '') ||
        m.artifactIds.includes(change.artifactId ?? '')
      )
        erase(journal)
    }
}

const running = new WeakMap<SlayzoneDb, Map<string, Promise<ErasureReport>>>()

/** Resume uses durable IDs captured before cascading deletes, never surviving rows. */
export function resumeErasure(
  db: SlayzoneDb,
  root: string,
  id: string,
  options: ErasureOptions = {}
): Promise<ErasureReport> {
  let jobs = running.get(db)
  if (!jobs) {
    jobs = new Map()
    running.set(db, jobs)
  }
  const pending = jobs.get(id)
  if (pending) return pending
  const merged = { ...configured.get(db), ...options }
  const work = (async () => {
    const before = await jobOf(db, id)
    const prior = JSON.stringify({
      db: before.db_erased,
      local: before.local_erased,
      report: await getErasureReport(db, id)
    })
    const report = await run(db, root, id, merged),
      after = await jobOf(db, id)
    if (prior !== JSON.stringify({ db: after.db_erased, local: after.local_erased, report })) {
      securityEvent({
        event: report.state === 'complete' ? 'content.erase.completed' : 'content.erase.incomplete',
        outcome: report.state === 'complete' ? 'success' : 'failure',
        actor: before.actor_user_id,
        targetKind: 'erasure',
        targetId: id,
        detail: {
          counts: report.counts,
          remainingComputers: report.computers.filter((c) => !c.deleted).map((c) => c.id),
          failures: report.failures
        }
      })
      merged.onProgress?.(report)
    }
    return report
  })().finally(() => jobs!.delete(id))
  jobs.set(id, work)
  return work
}

async function run(
  db: SlayzoneDb,
  root: string,
  id: string,
  options: ErasureOptions
): Promise<ErasureReport> {
  let job = await jobOf(db, id)
  if (job.state === 'complete') return getErasureReport(db, id)
  let m = JSON.parse(job.manifest) as ErasureManifest
  const failures: string[] = []
  try {
    await options.beforeResume?.(m.scope)
    for (const dependency of m.dependencies) {
      const previous = await resumeErasure(db, root, dependency, options)
      if (previous.state !== 'complete') failures.push('EARLIER_ERASURE_NOT_FINISHED')
    }
    if (!job.db_erased) {
      await options.beforeDelete?.(m.taskIds)
      m = await db.namedTxn('content-erasure:commit', { id })
    }
  } catch {
    failures.push('DATABASE_CONTENT_NOT_DELETED')
    await db.run('UPDATE content_erasure_jobs SET failure_codes=? WHERE id=?', [
      JSON.stringify(failures),
      id
    ])
    return getErasureReport(db, id)
  }
  job = await jobOf(db, id)
  if (!job.local_erased) {
    let additionalErased = true
    try {
      await options.cleanupAdditionalStores?.({
        jobId: id,
        taskIds: m.taskIds,
        projectIds: m.projectIds,
        verifyOwnership: m.scope.kind === 'user'
      })
    } catch (error) {
      additionalErased = false
      failures.push(
        error instanceof Error && error.message === 'LEGACY_DIAGNOSTICS_NEED_OWNERSHIP_REVIEW'
          ? error.message
          : 'DIAGNOSTIC_CONTENT_NOT_DELETED'
      )
    }
    try {
      cleanupFiles(
        root,
        m,
        options.removePath ?? ((file) => rmSync(file, { recursive: true, force: true }))
      )
      const gc = await db.namedTxn('content-erasure:collect-blobs', { id, dataRoot: root })
      await db.run(
        'UPDATE content_erasure_jobs SET retained_shared_blobs=?,retained_backup_blobs=? WHERE id=?',
        [gc.shared, gc.backup, id]
      )
      if (gc.deferred) failures.push('BLOB_CLEANUP_WAITING_FOR_BACKUP')
      else {
        // Remove old free pages and WAL frames, not just visible rows. A busy
        // checkpoint remains incomplete and retries; no physical-disk claim.
        await db.run('UPDATE content_erasure_jobs SET manifest=? WHERE id=?', [
          JSON.stringify(m),
          id
        ])
        await db.namedTxn('content-erasure:compact', {})
        if (additionalErased)
          await db.run('UPDATE content_erasure_jobs SET local_erased=1 WHERE id=?', [id])
      }
    } catch {
      failures.push('LOCAL_FILES_NOT_DELETED')
    }
  }
  if (options.cleanupComputer)
    for (const target of m.computers) {
      try {
        const replies = await options.cleanupComputer({
          jobId: id,
          computerId: target.id,
          taskIds: target.taskIds
        })
        for (const taskId of target.taskIds) {
          const lifecycle = await db.get<{ state: string; revision: number }>(
            'SELECT state,revision FROM chat_task_lifecycle WHERE task_id=?',
            [taskId]
          )
          const reply = replies.find((r) => r.taskId === taskId)
          if (
            !reply ||
            reply.erased !== true ||
            !lifecycle ||
            lifecycle.state !== 'deleted' ||
            reply.revision !== lifecycle.revision
          )
            throw new Error('COMPUTER_ACK_INVALID')
          await db.run(
            `INSERT INTO content_erasure_computer_acks(job_id,computer_id,task_id,revision) VALUES(?,?,?,?)
          ON CONFLICT(job_id,computer_id,task_id) DO UPDATE SET revision=excluded.revision,verified_at=datetime('now')`,
            [id, target.id, taskId, reply.revision]
          )
        }
      } catch {
        /* The named computer stays visibly undeleted; reconnect retries. */
      }
    }
  if (m.scope.kind === 'user') {
    try {
      if (await hasUnattributedFiles(db, root)) failures.push('LEGACY_FILES_NEED_OWNERSHIP_REVIEW')
    } catch {
      failures.push('OWNERSHIP_INVENTORY_UNAVAILABLE')
    }
  }
  await db.run('UPDATE content_erasure_jobs SET failure_codes=? WHERE id=?', [
    JSON.stringify(failures),
    id
  ])
  for (const worktree of m.worktrees) {
    if (worktree.deleted) continue
    try {
      // Re-check after intent commit: another task may now share this directory.
      const shared = await db.get(
        `SELECT 1 FROM tasks WHERE worktree_path=? AND coalesce(worktree_computer_id,computer_id) IS ? LIMIT 1`,
        [worktree.path, worktree.computerId]
      )
      if (!shared) {
        if (!options.cleanupWorktree) throw new Error('WORKTREE_CLEANUP_UNAVAILABLE')
        await options.cleanupWorktree(worktree)
      }
      worktree.deleted = true
      await db.run('UPDATE content_erasure_jobs SET manifest=? WHERE id=?', [JSON.stringify(m), id])
    } catch {
      failures.push('WORKTREE_NOT_DELETED')
    }
  }
  await db.run('UPDATE content_erasure_jobs SET failure_codes=? WHERE id=?', [
    JSON.stringify([...new Set(failures)]),
    id
  ])
  const report = await getErasureReport(db, id)
  job = await jobOf(db, id)
  if (
    job.db_erased &&
    job.local_erased &&
    !failures.length &&
    report.computers.every((c) => c.deleted)
  ) {
    // Retain replay identifiers and counts, not file names, after completion.
    m.worktrees = []
    await db.run(
      `UPDATE content_erasure_jobs SET state='complete',manifest=?,completed_at=datetime('now') WHERE id=?`,
      [JSON.stringify(m), id]
    )
  }
  return getErasureReport(db, id)
}

export async function eraseContent(
  db: SlayzoneDb,
  root: string,
  scope: ErasureScope,
  options: ErasureOptions = {}
): Promise<ErasureReport> {
  await (options.beforeResume ?? configured.get(db)?.beforeResume)?.(scope)
  if (scope.kind === 'user') {
    const existing = await db.get<{ id: string }>(
      `SELECT id FROM content_erasure_jobs WHERE owner_user_id=?
      AND json_extract(scope,'$.kind')='user' AND state='incomplete' ORDER BY created_at LIMIT 1`,
      [scope.userId]
    )
    if (existing) return resumeErasure(db, root, existing.id, options)
  }
  const id = randomUUID()
  const actorUserId = options.actorUserId ?? currentSecurityContext()?.actor ?? null
  const manifest = await db.namedTxn('content-erasure:prepare', { id, scope, actorUserId })
  securityEvent({
    event: 'content.erase.started',
    outcome: 'success',
    actor: actorUserId,
    targetKind: 'erasure',
    targetId: id,
    detail: { scope: scope.kind, counts: manifest.counts }
  })
  return resumeErasure(db, root, id, options)
}

export async function exportErasureReceipt(db: SlayzoneDb, id: string): Promise<ErasureReceipt> {
  const job = await jobOf(db, id)
  return {
    version: 1,
    jobId: id,
    scope: JSON.parse(job.scope) as ErasureScope,
    completedAt: job.completed_at,
    report: await getErasureReport(db, id)
  }
}

export type { ErasureManifest } from './manifest'
