import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { publicProcedure, router, type TrpcContext } from '@slayzone/trpc-server'
import { AdminContentErasureError, type ErasureActor } from '@slayzone/content-erasure/admin'
import { getHubAdminDeps } from './router-deps'
import { getErasureReport, resumeErasure, exportErasureReceipt } from './index'
import type { ErasureJob } from './manifest'

const user = z.object({ userId: z.string().min(1) })
function deps() {
  const configured = getHubAdminDeps()
  if (!configured?.users.ready())
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'User management is unavailable on this hub.'
    })
  return configured
}
function actor(ctx: TrpcContext): ErasureActor {
  if (!ctx.principal || ctx.principal.role !== 'admin' || !ctx.principal.scopes.includes('full'))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'User management requires a hub admin with a full session.'
    })
  return ctx.principal
}
async function adminCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    if (error instanceof TRPCError) throw error
    if (error instanceof AdminContentErasureError) {
      throw new TRPCError({
        code:
          error.code === 'ADMIN_ONLY'
            ? 'FORBIDDEN'
            : error.code === 'USER_NOT_FOUND'
              ? 'NOT_FOUND'
              : 'BAD_REQUEST',
        message: error.message
      })
    }
    // Never return a private file path or source content in an admin error.
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'The operation could not finish. Check cleanup status and retry.'
    })
  }
}

export const hubUsersRouter = router({
  access: publicProcedure.query(({ ctx }) => ({
    canReviewOwn: !ctx.principal || ctx.principal.scopes.includes('full'),
    canManage:
      ctx.principal?.role === 'admin' &&
      ctx.principal.scopes.includes('full') === true &&
      (getHubAdminDeps()?.users.ready() ?? false)
  })),
  list: publicProcedure.query(({ ctx }) => {
    actor(ctx)
    return deps().users.list()
  }),
  disable: publicProcedure
    .input(z.object({ email: z.string().trim().min(3).max(320) }))
    .mutation(async ({ ctx, input }) => {
      actor(ctx)
      const result = await deps().users.disable(input.email)
      if (result !== 'ok') {
        const message =
          result === 'last-admin'
            ? 'The last enabled admin cannot be disabled.'
            : result === 'last-user'
              ? 'The last enabled user cannot be disabled.'
              : result === 'protected'
                ? 'This internal or emergency account cannot be disabled here.'
                : 'User not found.'
        throw new TRPCError({ code: 'BAD_REQUEST', message })
      }
      return { disabled: true as const }
    }),
  previewErasure: publicProcedure
    .input(user)
    .query(({ ctx, input }) =>
      adminCall(() => deps().erasure.preview({ ...input, actor: actor(ctx) }))
    ),
  eraseContent: publicProcedure
    .input(user.extend({ confirmation: z.string() }))
    .mutation(({ ctx, input }) =>
      adminCall(() => deps().erasure.erase({ ...input, actor: actor(ctx) }))
    ),
  erasureReports: publicProcedure
    .input(user)
    .query(({ ctx, input }) =>
      adminCall(() => deps().erasure.reports({ ...input, actor: actor(ctx) }))
    ),
  retryErasure: publicProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .mutation(({ ctx, input }) =>
      adminCall(() => deps().erasure.retry({ ...input, actor: actor(ctx) }))
    ),
  erasureReceipt: publicProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(({ ctx, input }) =>
      adminCall(() => deps().erasure.receipt({ ...input, actor: actor(ctx) }))
    )
})

function owner(ctx: TrpcContext): string | null {
  if (ctx.principal && !ctx.principal.scopes.includes('full'))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Cleanup status requires a full session.' })
  return ctx.principal?.userId ?? null
}
async function ownJob(ctx: TrpcContext, id: string) {
  const uid = owner(ctx)
  const job = await ctx.db.get<ErasureJob>(
    'SELECT * FROM content_erasure_jobs WHERE id=? AND owner_user_id IS ?',
    [id, uid]
  )
  if (!job || JSON.parse(job.scope).kind === 'user')
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Erasure operation not found.' })
  return job
}
export const hubErasureRouter = router({
  reports: publicProcedure.query(async ({ ctx }) => {
    const uid = owner(ctx)
    const jobs = await ctx.db.all<{ id: string }>(
      `SELECT id FROM content_erasure_jobs WHERE owner_user_id IS ? AND state='incomplete' AND json_extract(scope,'$.kind')<>'user' ORDER BY created_at DESC LIMIT 100`,
      [uid]
    )
    return Promise.all(jobs.map((job) => getErasureReport(ctx.db, job.id)))
  }),
  retry: publicProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ownJob(ctx, input.jobId)
      const configured = getHubAdminDeps()
      if (!configured)
        throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Cleanup is unavailable.' })
      return resumeErasure(ctx.db, configured.dataRoot, input.jobId)
    }),
  receipt: publicProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await ownJob(ctx, input.jobId)
      return exportErasureReceipt(ctx.db, input.jobId)
    })
})
export type HubUserMounts = {
  hub: { users: typeof hubUsersRouter; erasure: typeof hubErasureRouter }
}
export { setHubAdminDeps, getHubAdminDeps, type HubAdminDeps } from './router-deps'
