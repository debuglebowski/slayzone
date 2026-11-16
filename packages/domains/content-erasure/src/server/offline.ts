import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SlayzoneDb, BatchOp } from '@slayzone/platform'
import { securityEvent } from '@slayzone/platform/security-log'
import type { ComputerErasureRequest } from '../shared'
import type { ErasureActor } from './admin'
import type { ErasureJob, ErasureManifest } from './manifest'
import { AdminContentErasureError } from './admin-errors'
import { resumeErasure } from './index'

const receiptSchema = z.object({
  request: z.object({
    version: z.literal(1),
    requestId: z.uuid(),
    jobId: z.uuid(),
    computerId: z.string().min(1),
    hubUrl: z.string(),
    hubScope: z.string(),
    tasks: z
      .array(z.object({ taskId: z.string().min(1), revision: z.number().int().positive() }))
      .min(1),
    worktreeTaskIds: z.array(z.string())
  }),
  verifiedAt: z.iso.datetime(),
  managedContentErased: z.literal(true),
  worktreesVerified: z.boolean()
})
export function createOfflineErasure(options: {
  db: SlayzoneDb
  dataRoot: string
  requireAdmin: (actor: ErasureActor) => void
  disabledUser: (id: string) => Promise<unknown>
  withAccountLock: <T>(id: string, run: () => Promise<T>) => Promise<T>
}) {
  const { db, dataRoot, requireAdmin, disabledUser } = options
  const invalid = (message: string) =>
    new AdminContentErasureError('INVALID_COMPUTER_RECEIPT', message)
  async function disabledJob(actor: ErasureActor, id: string) {
    requireAdmin(actor)
    const job = await db.get<ErasureJob>('SELECT * FROM content_erasure_jobs WHERE id=?', [id])
    if (!job?.owner_user_id)
      throw new AdminContentErasureError('USER_NOT_FOUND', 'Erasure operation not found.')
    await disabledUser(job.owner_user_id)
    return job
  }
  async function graph(root: ErasureJob) {
    const jobs = [root],
      seen = new Set([root.id])
    for (let i = 0; i < jobs.length; i++)
      for (const id of (JSON.parse(jobs[i].manifest) as ErasureManifest).dependencies) {
        if (seen.has(id)) continue
        const job = await db.get<ErasureJob>(
          'SELECT * FROM content_erasure_jobs WHERE id=? AND owner_user_id IS ?',
          [id, root.owner_user_id]
        )
        if (job) {
          seen.add(id)
          jobs.push(job)
        }
      }
    return jobs
  }
  return {
    async computerRequest(input: {
      actor: ErasureActor
      jobId: string
      computerId: string
      hubUrl: string
    }): Promise<ComputerErasureRequest> {
      const job = await disabledJob(input.actor, input.jobId),
        url = new URL(input.hubUrl)
      if (
        !['ws:', 'wss:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/computers'
      )
        throw invalid('Use this computer’s exact hub URL ending in /computers.')
      const targets = (await graph(job)).map((j) => JSON.parse(j.manifest) as ErasureManifest)
      const ids = [
        ...new Set(
          targets.flatMap((m) =>
            m.computers.filter((c) => c.id === input.computerId).flatMap((c) => c.taskIds)
          )
        )
      ]
      if (!ids.length) throw invalid('This computer is not part of the selected erasure.')
      const tasks: ComputerErasureRequest['tasks'] = []
      for (const taskId of ids) {
        const lifecycle = await db.get<{ revision: number; state: string }>(
          'SELECT revision,state FROM chat_task_lifecycle WHERE task_id=?',
          [taskId]
        )
        if (lifecycle?.state !== 'deleted')
          throw invalid('The deletion fence is not ready. Retry cleanup first.')
        tasks.push({ taskId, revision: lifecycle.revision })
      }
      const request: ComputerErasureRequest = {
        version: 1,
        requestId: randomUUID(),
        jobId: job.id,
        computerId: input.computerId,
        hubUrl: input.hubUrl,
        hubScope: url.port ? `${url.hostname}_${url.port}` : url.hostname,
        tasks,
        worktreeTaskIds: [
          ...new Set(
            targets.flatMap((m) =>
              m.worktrees
                .filter((w) => w.computerId === input.computerId && !w.deleted)
                .map((w) => w.taskId)
            )
          )
        ]
      }
      await db.run(
        'INSERT INTO content_erasure_offline_requests VALUES(?,?,?) ON CONFLICT(job_id,computer_id) DO UPDATE SET request_json=excluded.request_json',
        [job.id, input.computerId, JSON.stringify(request)]
      )
      return request
    },
    async confirmComputer(input: { actor: ErasureActor; receipt: unknown }) {
      requireAdmin(input.actor)
      const parsed = receiptSchema.safeParse(input.receipt)
      if (!parsed.success) throw invalid('Invalid computer cleanup receipt.')
      const receipt = parsed.data,
        request = receipt.request
      const job = await disabledJob(input.actor, request.jobId)
      return options.withAccountLock(job.owner_user_id!, async () => {
        await disabledUser(job.owner_user_id!)
        const issued = await db.get<{ request_json: string }>(
          'SELECT request_json FROM content_erasure_offline_requests WHERE job_id=? AND computer_id=?',
          [job.id, request.computerId]
        )
        if (
          !issued ||
          issued.request_json !== JSON.stringify(request) ||
          (request.worktreeTaskIds.length && !receipt.worktreesVerified)
        )
          throw invalid('The receipt does not match the current cleanup request.')
        for (const task of request.tasks) {
          const lifecycle = await db.get<{ state: string; revision: number }>(
            'SELECT state,revision FROM chat_task_lifecycle WHERE task_id=?',
            [task.taskId]
          )
          if (lifecycle?.state !== 'deleted' || lifecycle.revision !== task.revision)
            throw invalid('The cleanup request is stale. Create a new request.')
        }
        const updates: BatchOp[] = []
        for (const related of await graph(job)) {
          const m = JSON.parse(related.manifest) as ErasureManifest
          for (const target of m.computers.filter((c) => c.id === request.computerId))
            for (const taskId of target.taskIds) {
              const task = request.tasks.find((t) => t.taskId === taskId)
              if (task)
                updates.push({
                  type: 'run',
                  sql: `INSERT INTO content_erasure_computer_acks(job_id,computer_id,task_id,revision,method) VALUES(?,?,?,?,'operator') ON CONFLICT(job_id,computer_id,task_id) DO UPDATE SET revision=excluded.revision,method='operator',verified_at=datetime('now')`,
                  params: [related.id, request.computerId, taskId, task.revision]
                })
            }
          for (const w of m.worktrees)
            if (w.computerId === request.computerId && request.worktreeTaskIds.includes(w.taskId))
              w.deleted = true
          updates.push({
            type: 'run',
            sql: 'UPDATE content_erasure_jobs SET manifest=? WHERE id=?',
            params: [JSON.stringify(m), related.id]
          })
        }
        await db.batchTxn(updates)
        securityEvent({
          event: 'content.erase.computer-confirmed',
          outcome: 'success',
          actor: input.actor.userId,
          targetKind: 'computer',
          targetId: request.computerId,
          detail: {
            jobId: job.id,
            requestId: request.requestId,
            method: 'operator',
            verifiedAt: receipt.verifiedAt
          }
        })
        return resumeErasure(db, dataRoot, job.id)
      })
    }
  }
}
