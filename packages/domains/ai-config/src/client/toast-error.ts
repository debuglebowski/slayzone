import { toast } from '@slayzone/ui'

/**
 * Says a failed AI-config file operation out loud: a refused write (path jail, owner
 * check, no computer) must never leave an edit on screen that is not on disk.
 */
export function toastAiConfigError(what: string, err: unknown): void {
  const reason = err instanceof Error && err.message ? err.message : String(err)
  toast.error(`${what}: ${reason}`)
}
