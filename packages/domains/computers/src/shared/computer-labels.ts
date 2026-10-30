/**
 * How every client names a computer and its state: desktop (Settings → Connections,
 * a task's Computer card) and the mobile app use the same words. Pure, no imports:
 * also exported alone as `@slayzone/computers/labels`, so a client that must not load
 * Node or the DOM (the mobile app) can import it.
 */

export type ComputerStatusTone = 'ok' | 'idle' | 'bad'

/** The fields of a `computers.list` row the status reads. */
export interface ComputerStatusRow {
  connected: boolean
  usable?: boolean
  lastSeenAt: number | null
  revokedAt?: number | null
}

/**
 * Connection state and last-seen as ONE field: "can this take work right now, and
 * if not, when did it last check in".
 *
 * Five states, not two. `usable` (socket open AND inside the heartbeat window)
 * differs from `connected` while a computer has gone silent but its watchdog has not
 * reaped it yet, and that gap is exactly when a binary Connected/Offline lies.
 * REVOKED outranks everything: it is a deliberate act, and reporting connectivity
 * for a computer whose credential was pulled would describe the wrong thing entirely.
 */
export function computerStatus(row: ComputerStatusRow): {
  label: string
  tone: ComputerStatusTone
} {
  if (row.revokedAt != null) return { label: 'Revoked', tone: 'bad' }
  if (row.usable) return { label: 'Connected', tone: 'ok' }
  // Socket open but silent — it will be reaped, and until then it cannot take work.
  if (row.connected) return { label: 'Not responding', tone: 'bad' }
  if (row.lastSeenAt == null) return { label: 'Never connected', tone: 'idle' }
  return { label: `Offline · last seen ${new Date(row.lastSeenAt).toLocaleString()}`, tone: 'idle' }
}

/**
 * A computer's name for a binding: no computer (null) runs on the hub's own machine,
 * "Local"; an id the list does not hold (revoked, another user's) is unknown.
 */
export function computerName(
  computers: readonly { id: string; name: string }[],
  id: string | null
): string {
  if (id == null) return 'Local'
  return computers.find((c) => c.id === id)?.name ?? 'Unknown computer'
}

/** The task binding that follows its project: named after the project's default. */
export function inheritComputerLabel(defaultName: string): string {
  return `Inherit project default (${defaultName})`
}

/** Where a task's agents start, by computer name. */
export function runsOnLabel(name: string): string {
  return `Runs on ${name}`
}

/**
 * Beside a computer that cannot take work now. Offline is WARNED, never disabled:
 * work aimed at an offline computer queues until it returns, and binding a project
 * to a sleeping laptop is the normal case.
 */
export const OFFLINE_MARK = 'offline'

/** A hub with no computer enrolled runs everything itself. */
export const NO_COMPUTERS_NOTE = 'No computers — runs locally'
