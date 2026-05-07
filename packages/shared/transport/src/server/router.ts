import { router } from './trpc'
import { tagsRouter } from './routers/tags'

export const appRouter = router({
  tags: tagsRouter,
})

export type AppRouter = typeof appRouter
