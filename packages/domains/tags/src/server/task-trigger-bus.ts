// Task-trigger bus — the AutomationEngine's `start(bus)` listens here for
// `db:taskTags:setForTask:done` (the tag-change trigger). Legacy host emitted it
// on `ipcMain`; the tRPC `tags.setForTask` path never did (the pre-existing
// trigger gap). The side-car sets this to the SAME EventEmitter it passes to
// `engine.start()`, so `tags.setForTask` can fire the trigger. Nullable — when
// unset (host/standalone with no started engine) the tags path just no-ops it.
//
// Lives with the tags router (its only emitter); `@slayzone/api` re-exports the
// setter so the hub's composition wires it where it wires every other host dep.
export type TaskTriggerBus = {
  emit: (channel: string, ...args: unknown[]) => boolean
}

let taskTriggerBus: TaskTriggerBus | null = null

export function setTaskTriggerBus(bus: TaskTriggerBus): void {
  taskTriggerBus = bus
}

export function getTaskTriggerBus(): TaskTriggerBus | null {
  return taskTriggerBus
}
