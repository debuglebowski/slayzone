/**
 * The names a SlayZone service unit is known by — its launchd label and systemd unit
 * name — and the rule a service name must satisfy.
 *
 * A lean leaf (no process spawning, no filesystem): the hub reads these to recognise
 * that launchd or systemd is running it (apps/hub hub-restart.ts), and the hub bundle
 * may not import anything that spawns processes (scripts/check-hub-exec-imports.mjs).
 * service-unit.ts writes and drives the units with the same table.
 *
 * @module platform/service-identity
 */

/** Which SlayZone process a unit supervises. Drives identity + pinned env. */
export type ServiceKind = 'hub' | 'computer' | 'computer-host'

/**
 * Per-kind identity. The prefixes reach a FILENAME and a launchd Label, so they are
 * also what keeps the two kinds' units from ever being mistaken for one another —
 * `listRegisteredUnits('computer')` will not see a hub, and vice versa.
 */
export const KINDS = {
  'computer-host': {
    labelPrefix: 'com.slayzone.session-host.',
    systemdPrefix: 'slayzone-session-host-',
    description: 'SlayZone persistent session host',
    outLog: 'session-host.out.log',
    errLog: 'session-host.err.log',
    logsCommand: 'slay computer logs',
    renameHint: 'Use the computer service name.'
  },
  hub: {
    labelPrefix: 'com.slayzone.hub.',
    systemdPrefix: 'slayzone-hub-',
    description: 'SlayZone hub',
    /** launchd stdout/stderr basenames (systemd uses journald). */
    outLog: 'hub.out.log',
    errLog: 'hub.err.log',
    /** The `slay … logs <name>` command, quoted in the systemd unit's comment. */
    logsCommand: 'slay hub logs',
    /** How an operator picks a different name — quoted in the invalid-name error. */
    renameHint: 'Rename with `--name` or the config.json `hubName` key.'
  },
  computer: {
    labelPrefix: 'com.slayzone.computer.',
    systemdPrefix: 'slayzone-computer-',
    description: 'SlayZone computer',
    outLog: 'computer.out.log',
    errLog: 'computer.err.log',
    logsCommand: 'slay computer logs',
    renameHint: 'Pick a different name for `slay computer create`.'
  }
} as const satisfies Record<ServiceKind, unknown>

/**
 * Service names allowed in a unit filename.
 *
 * Deliberately strict: the name reaches a FILE PATH and the INTERIOR of a unit file,
 * so `..`/`/` would let `create` write outside the unit dir, and a newline would
 * inject arbitrary directives (`Restart=always`) into a systemd unit. Letters,
 * digits, dot, dash and underscore cover every name a hub or computer actually gets
 * (hub default: a directory basename), and a leading dot is refused so a name can
 * never be `.` or `..`.
 */
function isValidServiceName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name)
}

export function assertValidServiceName(kind: ServiceKind, name: string): void {
  if (!isValidServiceName(name)) {
    throw new Error(
      `[slayzone] invalid ${kind} name ${JSON.stringify(name)} — a name may contain only ` +
        `letters, digits, dot, dash and underscore (no slashes, spaces or newlines), ` +
        `and must not start with a dot. ${KINDS[kind].renameHint}`
    )
  }
}

/** The systemd unit name (not path) for `systemctl --user` arguments. */
export function systemdUnitName(kind: ServiceKind, name: string): string {
  assertValidServiceName(kind, name)
  return `${KINDS[kind].systemdPrefix}${name}.service`
}

/** The launchd label for `launchctl` arguments. */
export function launchdLabel(kind: ServiceKind, name: string): string {
  assertValidServiceName(kind, name)
  return `${KINDS[kind].labelPrefix}${name}`
}
