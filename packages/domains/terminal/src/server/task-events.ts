/**
 * Cross-domain "task reached terminal status" hook.
 *
 * The Electron implementation in pty-manager.ts kills PTYs + chats. Other
 * domains (integrations sync, etc.) call `onTaskReachedTerminal(taskId)` from
 * server-side code. Boot wiring (Electron app or @slayzone/server) registers
 * the actual handler via `setOnTaskReachedTerminalHandler`.
 *
 * Default is a no-op so server pkg works headless until the handler is wired.
 */
type Handler = (taskId: string) => void

let _handler: Handler = () => {}

export function setOnTaskReachedTerminalHandler(h: Handler): void {
  _handler = h
}

export function onTaskReachedTerminal(taskId: string): void {
  _handler(taskId)
}
