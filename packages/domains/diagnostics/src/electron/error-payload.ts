/**
 * The diagnostics payload for a main-process uncaught exception / unhandled rejection.
 *
 * `name` / `message` / `stack` / `value` are the raw error; the chat-privacy filter
 * withholds them before anything is stored (a rejection can quote a chat). Beside
 * them, the error's IDENTITY — class, Node error code, failing syscall, errno — which
 * that filter keeps when each is a bare identifier/number. Without it a rejection
 * with no JS stack frames (an fs or network error) was stored as `{}` and could not be
 * traced (pilot 2026-11-03: three startup rejections, cause unknown).
 */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function toErrorPayload(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { value: toErrorMessage(error), reasonType: typeof error }
  }
  const node = error as Error & { code?: unknown; syscall?: unknown; errno?: unknown }
  const errorClass =
    error.name && error.name !== 'Error' ? error.name : (error.constructor?.name ?? 'Error')
  return {
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
    errorClass,
    ...(typeof node.code === 'string' ? { errorCode: node.code } : {}),
    ...(typeof node.syscall === 'string' ? { errorSyscall: node.syscall } : {}),
    ...(typeof node.errno === 'number' ? { errno: node.errno } : {})
  }
}
