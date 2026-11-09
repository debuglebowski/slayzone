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
import { isErasureDoneOrCompacting } from '../shared'
import { SHARED_WORKTREE_SQL, addComputerTask } from './manifest'
import type {
  ErasureJob,
  ErasureLocalSteps,
  ErasureManifest,
  ErasureWorktreeComputer
} from './manifest'
import {
  createCompactionScheduler,
  type CompactionScheduler,
  type CompactionTiming
} from './compaction'
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
  /** The hub's default computer for a worktree no binding names (an unbound task's):
   *  where its work ran. Asked until it answers; the answer is then persisted. */
  resolveWorktreeComputer?: (target: {
    taskId: string
    projectId: string | null
    ownerUserId: string | null
  }) => Promise<ErasureWorktreeComputer>
  cleanupAdditionalStores?: (target: {
    jobId: string
    taskIds: string[]
    projectIds: string[]
    verifyOwnership: boolean
  }) => Promise<void>
  /** Compacts the stores `cleanupAdditionalStores` erased from (diagnostics). Runs with
   *  every database compaction; must VACUUM only when that store had erasures since. */
  compactAdditionalStores?: () => Promise<void>
  /** Item erasures (tasks, projects, artifacts) leave the database compaction to one
   *  run per burst (compaction.ts) and report `compactionPending` meanwhile. Absent:
   *  each erasure compacts before it returns. Account erasure always compacts inline. */
  compaction?: CompactionTiming
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

const RETRY_BASE_MS = 30_000
const RETRY_CAP_MS = 30 * 60_000

/**
 * Resumes unfinished jobs: all at start and on `retry()` (reconnect, manual), and on
 * a 30 s tick only the jobs whose backoff is due. A job that still has outstanding work
 * waits 30 s, 60 s, 120 s ... up to 30 min between automatic attempts. Jobs waiting
 * only for their scheduled compaction are left to the compaction scheduler.
 */
export function startErasureRetries(db: SlayzoneDb, root: string) {
  let stopped = false,
    pending: Promise<void> | null = null
  const backoff = new Map<string, { failures: number; nextAt: number }>()
  function attempt(all: boolean): Promise<void> {
    if (stopped) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      const jobs = await db.all<{ id: string }>(
        "SELECT id FROM content_erasure_jobs WHERE state='incomplete' ORDER BY created_at"
      )
      for (const job of jobs) {
        if (stopped) break
        const due = backoff.get(job.id)
        if (!all && (schedulers.get(db)?.isWaiting(job.id) || (due && due.nextAt > Date.now())))
          continue
        let settled = false
        try {
          settled = isErasureDoneOrCompacting(await resumeErasure(db, root, job.id))
        } catch {
          /* Durable intent survives until the next retry. */
        }
        if (settled) backoff.delete(job.id)
        else {
          const failures = (due?.failures ?? 0) + 1
          backoff.set(job.id, {
            failures,
            nextAt: Date.now() + Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_CAP_MS)
          })
        }
      }
    })().finally(() => {
      pending = null
    })
    return pending
  }
  const retry = () => attempt(true)
  const timer = setInterval(() => {
    void attempt(false).catch(() => undefined)
  }, RETRY_BASE_MS)
  timer.unref()
  void retry().catch(() => undefined)
  return {
    retry,
    async close() {
      stopped = true
      clearInterval(timer)
      schedulers.get(db)?.close()
      await pending
      await Promise.allSettled([...(running.get(db)?.values() ?? [])])
    }
  }
}

const schedulers = new WeakMap<SlayzoneDb, CompactionScheduler>()
/** Generations a deferred run covered, applied by the job's next pass (run()). */
const coveredRuns = new WeakMap<SlayzoneDb, Map<string, { changes: number; hub: number }>>()
function schedulerFor(db: SlayzoneDb): CompactionScheduler {
  let scheduler = schedulers.get(db)
  if (!scheduler) {
    scheduler = createCompactionScheduler({
      compactHub: () => db.namedTxn('content-erasure:compact', {})
    })
    schedulers.set(db, scheduler)
  }
  return scheduler
}
function coveredOf(db: SlayzoneDb) {
  let covered = coveredRuns.get(db)
  if (!covered) {
    covered = new Map()
    coveredRuns.set(db, covered)
  }
  return covered
}

/** Runs every scheduled compaction now and waits for its jobs to finish their pass. */
export async function flushErasureCompaction(db: SlayzoneDb): Promise<void> {
  await schedulers.get(db)?.flush()
}

/** A job's local progress; a job from before step marks finished all of it at once. */
function localOf(job: ErasureJob, m: ErasureManifest): ErasureLocalSteps {
  if (m.local) return m.local
  return job.local_erased
    ? { diagnostics: true, files: true, changes: 0, hub: 0, compactedChanges: 0, hubCompacted: 0 }
    : { changes: 0, hub: 0 }
}
const isCompacted = (l: ErasureLocalSteps) =>
  l.compactedChanges === l.changes && l.hubCompacted === l.hub
const isLocalDone = (l: ErasureLocalSteps) => !!(l.diagnostics && l.files && isCompacted(l))

async function persistLocal(db: SlayzoneDb, id: string, m: ErasureManifest) {
  await db.run('UPDATE content_erasure_jobs SET manifest=?,local_erased=? WHERE id=?', [
    JSON.stringify(m),
    isLocalDone(m.local!) ? 1 : 0,
    id
  ])
}

/** Waits for a pass already running (it may predate a compaction), then resumes. */
async function resumeAfterRunning(
  db: SlayzoneDb,
  root: string,
  id: string,
  options: ErasureOptions = {}
): Promise<ErasureReport> {
  await running
    .get(db)
    ?.get(id)
    ?.catch(() => undefined)
  return resumeErasure(db, root, id, options)
}

/**
 * Asks for the database compaction that covers this job's current generations.
 * `compacted`: an inline run covered them (persisted). `failed`: the run failed.
 * `scheduled`: a deferred run will resume the job; `scheduled-after-failure` when the
 * previous run failed (reported, retried with backoff).
 */
async function requestCompaction(
  db: SlayzoneDb,
  root: string,
  id: string,
  m: ErasureManifest,
  options: ErasureOptions
): Promise<'compacted' | 'failed' | 'scheduled' | 'scheduled-after-failure'> {
  const local = m.local!
  const want = { changes: local.changes, hub: local.hub }
  const scheduler = schedulerFor(db)
  const timing = m.scope.kind === 'user' ? null : (options.compaction ?? null)
  const request = {
    jobId: id,
    hub: local.hubCompacted !== local.hub,
    additional: options.compactAdditionalStores
  }
  if (timing) {
    void scheduler.request(
      {
        ...request,
        finalize: async (ok: boolean) => {
          if (ok) coveredOf(db).set(id, want)
          return resumeAfterRunning(db, root, id)
        }
      },
      timing
    )
    return scheduler.lastRunFailed() ? 'scheduled-after-failure' : 'scheduled'
  }
  if (!(await scheduler.request(request, null))) return 'failed'
  local.compactedChanges = want.changes
  local.hubCompacted = want.hub
  await persistLocal(db, id, m)
  return 'compacted'
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
  const local = m.local
  const compactionPending =
    job.state === 'incomplete' &&
    !!job.db_erased &&
    !!local?.files &&
    !!local.diagnostics &&
    !isCompacted(local)
  return {
    id,
    state: job.state,
    counts: m.counts,
    computers,
    failures: JSON.parse(job.failure_codes) as string[],
    retainedSharedBlobs: job.retained_shared_blobs,
    retainedBackupBlobs: job.retained_backup_blobs,
    ...(compactionPending ? { compactionPending } : {})
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
      // Waiting only for the scheduled compaction is the normal path, not a failure:
      // the audit records the completion that follows it.
      if (report.state === 'complete' || !isErasureDoneOrCompacting(report))
        securityEvent({
          event:
            report.state === 'complete' ? 'content.erase.completed' : 'content.erase.incomplete',
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

/**
 * Where each pending worktree is, persisted so every retry asks the same computer.
 * The task/project binding was captured at planning; an unbound task's worktree is
 * on the hub's default computer, asked here — still null while none is usable. A
 * computer that is revoked or removed can never answer: that worktree is marked
 * gone and not retried. The repo folder is that computer's project folder, captured
 * at planning (a project's erasure removes it) or recorded since.
 */
async function locateWorktrees(
  db: SlayzoneDb,
  id: string,
  m: ErasureManifest,
  options: ErasureOptions
): Promise<void> {
  let changed = false
  for (const w of m.worktrees) {
    if (w.deleted || w.gone) continue
    if (!w.computerId && options.resolveWorktreeComputer) {
      const pick = await options
        .resolveWorktreeComputer({
          taskId: w.taskId,
          projectId: w.projectId ?? null,
          ownerUserId: w.ownerUserId !== undefined ? w.ownerUserId : m.ownerUserId
        })
        .catch(() => null)
      if (pick && pick.computerId !== null) {
        w.computerId = pick.computerId
        addComputerTask(m, pick.computerId, w.taskId)
        changed = true
      } else if (pick?.gone) {
        w.gone = true
        changed = true
      }
    }
    if (!w.computerId) continue
    const computer = await db.get<{ revoked_at: number | null }>(
      'SELECT revoked_at FROM computers WHERE id=?',
      [w.computerId]
    )
    if (!computer || computer.revoked_at != null) {
      w.gone = true
      changed = true
      continue
    }
    if (w.repoPath) continue
    const repoPath =
      w.repoPaths?.find((r) => r.computerId === w.computerId)?.path ??
      (w.projectId
        ? (
            await db.get<{ root_path: string }>(
              'SELECT root_path FROM project_placements WHERE project_id=? AND computer_id=?',
              [w.projectId, w.computerId]
            )
          )?.root_path
        : undefined)
    if (repoPath) {
      w.repoPath = repoPath
      changed = true
    }
  }
  if (changed)
    await db.run('UPDATE content_erasure_jobs SET manifest=? WHERE id=?', [JSON.stringify(m), id])
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
  // An earlier job that only waits for its scheduled compaction holds back this one's
  // completion without being a failure.
  let waitingForDependency = false
  try {
    await options.beforeResume?.(m.scope)
    for (const dependency of m.dependencies) {
      const previous = await resumeErasure(db, root, dependency, options)
      if (previous.state === 'complete') continue
      if (isErasureDoneOrCompacting(previous)) waitingForDependency = true
      else failures.push('EARLIER_ERASURE_NOT_FINISHED')
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
  // Before computer cleanup: a newly resolved worktree computer joins it.
  await locateWorktrees(db, id, m, options)
  job = await jobOf(db, id)
  // Each local step runs until it succeeds once; a retry never repeats a finished one.
  const local = localOf(job, m)
  m.local = local
  const covered = coveredOf(db).get(id)
  if (covered) {
    // A deferred run finished for these generations (later work stays uncovered).
    coveredOf(db).delete(id)
    local.compactedChanges = covered.changes
    local.hubCompacted = covered.hub
  }
  if (!local.diagnostics) {
    if (options.cleanupAdditionalStores) {
      // Even an attempt that fails verification may have removed content: its store
      // needs compacting again (a new generation; the hub database is untouched).
      local.changes++
      try {
        await options.cleanupAdditionalStores({
          jobId: id,
          taskIds: m.taskIds,
          projectIds: m.projectIds,
          verifyOwnership: m.scope.kind === 'user'
        })
        local.diagnostics = true
      } catch (error) {
        failures.push(
          error instanceof Error && error.message === 'LEGACY_DIAGNOSTICS_NEED_OWNERSHIP_REVIEW'
            ? error.message
            : 'DIAGNOSTIC_CONTENT_NOT_DELETED'
        )
      }
    } else local.diagnostics = true
  }
  if (!local.files) {
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
      else local.files = true
    } catch {
      failures.push('LOCAL_FILES_NOT_DELETED')
    }
  }
  await persistLocal(db, id, m)
  // Rows are gone: remove their old free pages and WAL frames too (compaction.ts). A
  // busy checkpoint stays incomplete and retries; no physical-disk claim.
  if (local.files && !isCompacted(local)) {
    const compaction = await requestCompaction(db, root, id, m, options)
    if (compaction === 'failed' || compaction === 'scheduled-after-failure')
      failures.push('DATABASE_HISTORY_NOT_COMPACTED')
  }
  if (options.cleanupComputer)
    for (const target of m.computers) {
      // Only what this computer has not confirmed yet: a confirmed computer is never
      // asked again (each request makes it VACUUM its own database).
      const unconfirmed: string[] = []
      for (const taskId of target.taskIds)
        if (
          !(await db.get(
            `SELECT 1 FROM content_erasure_computer_acks a
            JOIN chat_task_lifecycle l ON l.task_id=a.task_id
            WHERE a.job_id=? AND a.computer_id=? AND a.task_id=? AND l.state='deleted' AND a.revision>=l.revision`,
            [id, target.id, taskId]
          ))
        )
          unconfirmed.push(taskId)
      if (!unconfirmed.length) continue
      try {
        const replies = await options.cleanupComputer({
          jobId: id,
          computerId: target.id,
          taskIds: unconfirmed
        })
        for (const taskId of unconfirmed) {
          const lifecycle = await db.get<{ state: string; revision: number }>(
            'SELECT state,revision FROM chat_task_lifecycle WHERE task_id=?',
            [taskId]
          )
          const reply = replies.find((r) => r.taskId === taskId)
          // An invalid or missing reply leaves that task unconfirmed; others still count.
          if (
            !reply ||
            reply.erased !== true ||
            !lifecycle ||
            lifecycle.state !== 'deleted' ||
            reply.revision !== lifecycle.revision
          )
            continue
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
      const shared = await db.get(SHARED_WORKTREE_SQL, [
        worktree.path,
        JSON.stringify(m.taskIds),
        worktree.computerId,
        worktree.computerId
      ])
      if (!shared) {
        // Never automatic: only the operator procedure can verify it (offline.ts).
        if (worktree.gone) {
          failures.push('WORKTREE_COMPUTER_GONE')
          continue
        }
        if (!worktree.computerId) {
          failures.push('WORKTREE_COMPUTER_UNAVAILABLE')
          continue
        }
        if (!worktree.repoPath) {
          failures.push('WORKTREE_LOCATION_UNKNOWN')
          continue
        }
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
    local.diagnostics &&
    local.files &&
    !failures.length &&
    report.computers.every((c) => c.deleted)
  ) {
    if (m.worktrees.length) {
      // Worktree paths can contain private task titles. Remove the retry paths
      // before the last compaction, including their older SQLite/WAL images.
      // Persist incomplete cleanup first so a busy checkpoint or restart retries
      // verification without requiring the already-removed worktree again.
      m.worktrees = []
      local.hub++
      await persistLocal(db, id, m)
    }
    if (!isCompacted(local)) {
      const compaction = await requestCompaction(db, root, id, m, options)
      if (compaction !== 'compacted') {
        if (compaction !== 'scheduled')
          await db.run('UPDATE content_erasure_jobs SET failure_codes=? WHERE id=?', [
            JSON.stringify(['DATABASE_HISTORY_NOT_COMPACTED']),
            id
          ])
        return getErasureReport(db, id)
      }
    }
    if (waitingForDependency) {
      // An inline compaction also ran the earlier jobs' scheduled one: see them finish.
      waitingForDependency = false
      for (const dependency of m.dependencies)
        if ((await resumeAfterRunning(db, root, dependency, options)).state !== 'complete')
          waitingForDependency = true
      if (waitingForDependency) return getErasureReport(db, id)
    }
    await db.run(
      `UPDATE content_erasure_jobs SET state='complete',local_erased=1,completed_at=datetime('now') WHERE id=?`,
      [id]
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
    // Whose content: the erased account's id (never its email) for a user erasure.
    detail: {
      scope: scope.kind,
      ...(scope.kind === 'user' ? { userId: scope.userId } : {}),
      counts: manifest.counts
    }
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
