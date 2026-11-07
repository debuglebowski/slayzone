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
  /** Enrolled and connected, but given no new work (`computers.setDisabled`). */
  disabledAt?: number | null
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
 * DISABLED comes next, for the same reason: it takes no work whatever its socket says.
 */
export function computerStatus(row: ComputerStatusRow): {
  label: string
  tone: ComputerStatusTone
} {
  if (row.revokedAt != null) return { label: 'Revoked', tone: 'bad' }
  if (row.disabledAt != null) return { label: 'Disabled', tone: 'idle' }
  if (row.usable) return { label: 'Connected', tone: 'ok' }
  // Socket open but silent — it will be reaped, and until then it cannot take work.
  if (row.connected) return { label: 'Not responding', tone: 'bad' }
  if (row.lastSeenAt == null) return { label: 'Never connected', tone: 'idle' }
  return { label: `Offline · last seen ${new Date(row.lastSeenAt).toLocaleString()}`, tone: 'idle' }
}

/** Every phase a computer's auto-upgrade reports. The status schema is built from this. */
export const COMPUTER_UPGRADE_PHASES = [
  'checking',
  'installing',
  'waiting-for-idle',
  'restarting',
  'probation',
  'connected',
  'rollback',
  'failed',
  'maintenance-required'
] as const
export type ComputerUpgradePhase = (typeof COMPUTER_UPGRADE_PHASES)[number]

/** The fields of a reported upgrade status the labels read. */
export interface ComputerUpgradeRow {
  phase: ComputerUpgradePhase
  currentVersion: string
  hostVersion: string
  version?: string
  target?: string
  error?: string
  retryAt?: number
  maintenanceReason?: string
}

/** The failed-check target the upgrader uses before it knows a release. */
const DISCOVERY_TARGET = 'discovery'

/**
 * What an upgrade adds to the status column, or null when there is nothing to say.
 * `connected` (on the release the hub wants) and `checking` (the periodic poll) are
 * the steady state: printing them on every row was noise.
 */
function upgradeStatusLabel(
  u: ComputerUpgradeRow
): { label: string; detail?: string; tone: ComputerStatusTone } | null {
  const target = u.target ?? 'new release'
  switch (u.phase) {
    case 'checking':
    case 'connected':
      return null
    case 'installing':
      return { label: 'Upgrading', detail: `Installing ${target}`, tone: 'ok' }
    case 'waiting-for-idle':
      return { label: 'Upgrading', detail: `${target} · waiting for idle`, tone: 'ok' }
    case 'restarting':
      return { label: 'Upgrading', detail: `Restarting into ${target}`, tone: 'ok' }
    case 'probation':
      return { label: 'Upgrading', detail: `Verifying ${target}`, tone: 'ok' }
    case 'rollback':
      return { label: 'Rolling back', detail: `to ${target}`, tone: 'bad' }
    case 'maintenance-required':
      return { label: 'Upgrade blocked', detail: 'host maintenance pending', tone: 'bad' }
    case 'failed': {
      if (u.target === DISCOVERY_TARGET || u.target == null)
        return { label: 'Update check failed', tone: 'bad' }
      const retry = u.retryAt != null ? ` · retry ${new Date(u.retryAt).toLocaleTimeString()}` : ''
      return { label: 'Upgrade failed', detail: `${u.target}${retry}`, tone: 'bad' }
    }
  }
}

/**
 * A computer row's status cell: connection and upgrade as ONE field, because an
 * upgrade is a state of the computer, not metadata about it.
 *
 * Connection trouble outranks the upgrade: a computer that cannot take work (or was
 * revoked) is not reporting, so its last upgrade phase is stale.
 */
export function computerRowStatus(
  row: ComputerStatusRow & { upgradeStatus?: ComputerUpgradeRow | null }
): { label: string; detail?: string; tone: ComputerStatusTone } {
  const conn = computerStatus(row)
  if (conn.tone !== 'ok' || !row.upgradeStatus) return conn
  return upgradeStatusLabel(row.upgradeStatus) ?? conn
}

/** Hover text for an upgrade: why it failed or is blocked, else which versions. */
export function computerUpgradeTitle(u: ComputerUpgradeRow): string {
  return (
    u.error ??
    u.maintenanceReason ??
    `Connector ${u.version ?? u.currentVersion} · host ${u.hostVersion}`
  )
}

/**
 * What a default computer reports. The computer app's `DEFAULT_CAPABILITIES` is
 * asserted equal to this, so the two cannot drift.
 */
export const STANDARD_COMPUTER_CAPABILITIES = ['pty', 'git', 'fs', 'proc'] as const

/**
 * How a computer's capabilities differ from the standard set, or null when they do
 * not. Every default computer reports the same four, so listing them on each row
 * said nothing; what matters is a computer that cannot (or can additionally) do X.
 */
export function capabilityNote(capabilities: readonly string[]): string | null {
  if (capabilities.length === 0) return 'no capabilities'
  const have = new Set(capabilities)
  // `desktop` marks a desktop app's own computer joined to another hub — not a thing
  // it can or cannot do; the row says "this computer" where it matters.
  const standard = new Set<string>([...STANDARD_COMPUTER_CAPABILITIES, 'desktop'])
  const missing = STANDARD_COMPUTER_CAPABILITIES.filter((c) => !have.has(c))
  const extra = capabilities.filter((c) => !standard.has(c))
  const parts: string[] = []
  if (missing.length > 0) parts.push(`no ${missing.join(', ')}`)
  if (extra.length > 0) parts.push(extra.map((c) => `+${c}`).join(', '))
  return parts.length > 0 ? parts.join(' · ') : null
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

/** Beside a DISABLED computer (Settings → Connections): it takes no new work, so it
 *  cannot be chosen for any. */
export const DISABLED_MARK = 'disabled'

/** A hub with no computer enrolled runs everything itself. */
export const NO_COMPUTERS_NOTE = 'No computers — runs locally'

/**
 * The first release whose computers confirm chat writes (dedupe on retry, a refused
 * write instead of a silent ack, the binary pre-check). An older computer keeps
 * working, unconfirmed, and cannot upgrade itself (its release predates hub-driven
 * upgrades): it is updated by hand.
 */
export const CHAT_CONFIRMED_WRITES_SINCE = '0.36.3'

/** `major.minor.patch` of a release string (`v` prefix, `-beta.N` suffix allowed). */
function releaseCore(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * Which computer runs a release older than confirmed chat writes, and what to do —
 * null when it confirms them or its version is unknown. A prerelease counts as its
 * release (`0.36.3-beta.1` confirms).
 */
export function outdatedComputerNote(row: {
  name: string
  version?: string | null
}): string | null {
  const have = row.version ? releaseCore(row.version) : null
  const need = releaseCore(CHAT_CONFIRMED_WRITES_SINCE)!
  if (!have) return null
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) {
      if (have[i] > need[i]) return null
      return (
        `${row.name} runs SlayZone ${row.version}: messages to chat agents on it are not confirmed, ` +
        'so one lost on the way is not noticed. Update the SlayZone CLI on that machine, then run ' +
        `\`slay computer restart ${row.name}\`.`
      )
    }
  }
  return null
}
