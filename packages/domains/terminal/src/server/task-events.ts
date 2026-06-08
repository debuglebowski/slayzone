/**
 * Cross-domain "task reached a terminal status" seam — electron-free.
 *
 * The real implementation (kill PTYs + shut down chat transports) lives in the
 * Electron-coupled pty-manager (`../electron`). Server-side callers in other
 * domains (e.g. integrations sync, which imports nothing Electron) invoke
 * `onTaskReachedTerminal(taskId)` here; the Electron host wires the real handler
 * via `setOnTaskReachedTerminalHandler` at boot. Default is a no-op so the
 * server package works headless until the handler is registered.
 */
type TaskReachedTerminalHandler = (taskId: string) => void

let handler: TaskReachedTerminalHandler = () => {}

export function setOnTaskReachedTerminalHandler(h: TaskReachedTerminalHandler): void {
  handler = h
}

export function onTaskReachedTerminal(taskId: string): void {
  handler(taskId)
}
