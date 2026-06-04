// App-level dependencies that the router needs but cannot import directly.
//
// The chat ops live in `@slayzone/terminal/main`, which lazily `require`s
// `electron` and pulls in `node-pty` — both forbidden inside the transport
// package (it must run under plain Node for the standalone `@slayzone/server`
// host). So we `import type` only (erased at build → zero electron at runtime)
// and the Electron-main host injects the concrete instances at startup via
// `setChatDeps()`. A standalone server without these wired would throw on the
// first chat procedure call.

import type { TypedEmitter } from '@slayzone/platform/events'
import type {
  createChatOps,
  createChatQueueOps,
  ChatEventMap,
  ChatQueueEventMap
} from '@slayzone/terminal/main'
import type { IntegrationOps } from '@slayzone/integrations/main'
import type { TaskOps } from '@slayzone/task/main'

// Chat deps — ops + queue ops + the two streaming emitters the subscriptions
// subscribe to. Same instances back the IPC handlers (coexistence until slice 5).
export type ChatDeps = {
  ops: ReturnType<typeof createChatOps>
  queueOps: ReturnType<typeof createChatQueueOps>
  events: TypedEmitter<ChatEventMap>
  queueEvents: TypedEmitter<ChatQueueEventMap>
}

let chatDeps: ChatDeps | null = null

export function setChatDeps(deps: ChatDeps): void {
  chatDeps = deps
}

export function getChatDeps(): ChatDeps {
  if (!chatDeps) throw new Error('chatDeps not initialized — call setChatDeps() in main host first')
  return chatDeps
}

// Integration ops — the electron-coupled domain ops (`@slayzone/integrations/main`
// pulls electron + node clients), injected by the host so the `integrationsRouter`
// and the still-live IPC handlers share one instance (coexistence until slice 5).
let integrationOps: IntegrationOps | null = null

export function setIntegrationOps(ops: IntegrationOps): void {
  integrationOps = ops
}

export function getIntegrationOps(): IntegrationOps {
  if (!integrationOps)
    throw new Error('integrationOps not initialized — call setIntegrationOps() in main host first')
  return integrationOps
}

// Task CRUD/deps/board ops — electron-coupled (`createTaskOp` pulls
// `@slayzone/worktrees/main` → electron). `import type` only here (erased at build →
// zero electron at runtime); the Electron-main host injects the concrete bundle via
// `setTaskDeps()` so the `task` router and the still-live IPC handlers share one
// implementation (coexistence until slice 5). The artifacts/template stores are
// electron-free and imported directly by their routers — not injected.
let taskOps: TaskOps | null = null

export function setTaskDeps(deps: { ops: TaskOps }): void {
  taskOps = deps.ops
}

export function getTaskOps(): TaskOps {
  if (!taskOps)
    throw new Error('taskOps not initialized — call setTaskDeps() in main host first')
  return taskOps
}
