import { router } from './trpc'
import { diagnosticsRouter } from './routers/diagnostics'
import { projectsRouter } from './routers/projects'
import { tagsRouter } from './routers/tags'

export const appRouter = router({
  diagnostics: diagnosticsRouter,
  projects: projectsRouter,
  tags: tagsRouter,
})

export type AppRouter = typeof appRouter
