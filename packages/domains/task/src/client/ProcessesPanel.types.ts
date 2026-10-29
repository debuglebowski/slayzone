import type { ProcessInfo } from '@slayzone/processes/shared'

export type { ProcessStatus } from '@slayzone/processes/shared'

/** A row of the Processes panel: the process manager's `ProcessInfo` plus the
 *  dev-server URL the panel detects from a running process's log. */
export interface ProcessEntry extends ProcessInfo {
  serverUrl?: string | null
}
