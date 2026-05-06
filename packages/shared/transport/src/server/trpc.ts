import { initTRPC } from '@trpc/server'
import superjson from 'superjson'
import type { TrpcContext } from './context'

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
})

export const router = t.router
export const publicProcedure = t.procedure
export const middleware = t.middleware
export const mergeRouters = t.mergeRouters
