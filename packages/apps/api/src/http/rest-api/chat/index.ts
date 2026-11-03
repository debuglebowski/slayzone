import type { Express } from 'express'
import type { RestApiDeps } from '../types'
import { registerChatReadRoutes } from './read'
import { registerChatActRoutes } from './act'
import { registerChatManageRoutes } from './manage'
import { registerChatFollowRoute } from './follow'

/** `/api/chat/:id/*` — drive a task's chat agent (`slay chat`). See `_chat.ts`. */
export function registerChatRoutes(app: Express, deps: RestApiDeps): void {
  registerChatReadRoutes(app, deps)
  registerChatFollowRoute(app, deps)
  registerChatActRoutes(app, deps)
  registerChatManageRoutes(app, deps)
}
