import type { taskRouter } from './task-router'
import type { AgentSessionsRouter } from './agent-sessions-router'
import type { TemplateRouter } from './template-router'
import type { taskMovesRouter } from './task-moves-router'

export type TaskRouter = typeof taskRouter

/**
 * Where this domain's routers sit in the app router. One combined type, not one per
 * router: the three are one domain's surface (tasks, their agent sessions, their
 * templates) and the domain's client calls all three. `@slayzone/api` mounts them at
 * these keys and asserts the slice in its `router.ts`.
 */
export type TaskMounts = {
  task: TaskRouter
  agentSessions: AgentSessionsRouter
  template: TemplateRouter
  /** Moving tasks to another hub: each hub's journal of its tasks' moves. */
  taskMoves: typeof taskMovesRouter
}
