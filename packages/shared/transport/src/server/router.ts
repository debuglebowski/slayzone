import { router } from './trpc'
import { projectsRouter } from './routers/projects'
import { tagsRouter } from './routers/tags'

export const appRouter = router({
  projects: projectsRouter,
  tags: tagsRouter,
})

export type AppRouter = typeof appRouter
