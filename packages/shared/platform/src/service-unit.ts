/**
 * Hand a long-lived SlayZone process to the OS supervisor so it stays up.
 *
 * Two KINDS use this: the `hub` (`slay hub create`) and the `runner`
 * (`slay runner create`). Neither merely backgrounds the process — a detached spawn
 * dies for good on the first crash and never returns after a logout. Both
 * mainstream OSes already ship a supervisor that solves exactly this from a small
 * declarative file: launchd (macOS) and systemd --user (Linux). This module renders
 * and installs that file; the supervisor then owns restart-on-crash, start-at-login,
 * and log redirection. Nothing here reimplements supervision.
 *
 * WHY ONE MODULE FOR BOTH KINDS. The supervision requirement is identical — the only
 * differences are the unit's identity (label/filename prefix, Description, log
 * filenames) and which environment variables get pinned. Those live in {@link KINDS}
 * and {@link unitEnv}; everything else — backend detection, the plist/unit renderers,
 * name validation, the write/remove/list/read helpers — is shared. Two copies of a
 * plist renderer would drift.
 *
 * SCOPE OF THE GUARANTEE (say this accurately to operators): a launchd *user agent*
 * and a lingering systemd *user unit* restart the process on crash and start it at
 * LOGIN. Starting before any login needs a root-owned `/Library/LaunchDaemons` plist
 * or a systemd *system* unit — sudo territory, not done here. Windows has no
 * user-level equivalent, so `detectBackend()` returns `'none'` and the caller falls
 * back to a bare detached spawn.
 *
 * WHERE THE FILES GO. `~/Library/LaunchAgents` and `~/.config/systemd/user` are the
 * only directories those supervisors read, so the unit necessarily lives outside the
 * process's own ROOT. That is OS registration, not SlayZone state — no SlayZone data
 * leaves `<ROOT>`; the unit merely points at it.
 *
 * WHY THE COMMAND IS ABSOLUTE. The unit pins a resolved interpreter + script path
 * rather than `npx @slayzone/hub`: the supervisor re-executes this command on every
 * crash and at every login, and an `npx` there would mean a registry round-trip (and
 * a silent version drift) per restart. `slay hub restart --upgrade` /
 * `slay runner restart --upgrade` re-resolve deliberately.
 *
 * Lean leaf (node builtins only) so the CLI bundle can import
 * `@slayzone/platform/service-unit` without the platform barrel.
 *
 * @module platform/service-unit
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Which OS supervisor is available. `none` ⇒ caller must fall back. */
export type ServiceBackend = 'launchd' | 'systemd' | 'none'

/** Which SlayZone process a unit supervises. Drives identity + pinned env. */
export type ServiceKind = 'hub' | 'runner'

/** Everything a unit file needs to run one hub or runner. */
export interface ServiceUnitSpec {
  /** Which process this supervises — selects the identity + env shape. */
  kind: ServiceKind
  /** Service name — the unit's identity. Must satisfy {@link isValidServiceName}. */
  name: string
  /** SLAYZONE_ROOT: the process's anchor, pinned into the unit's environment. */
  root: string
  /** Absolute interpreter/binary path (never `npx` — see the module note). */
  command: string
  /** Arguments after `command`. */
  args: string[]
  /** Directory for the supervisor's stdout/stderr capture (launchd only; systemd
   *  uses journald). */
  logDir: string
  /**
   * Explicit bind AUTHORITY (`host[:port]`) — HUB ONLY, ignored for a runner.
   *
   * Supersedes {@link port}, which can only ever mean loopback. A REMOTE hub has to
   * bind wider than `127.0.0.1` to be reachable at all, and that is not
   * expressible as a port number. Emitted verbatim as `SLAYZONE_HUB_ADDRESS`, so
   * the value is exactly what the operator asked for. Wins when both are set.
   */
  address?: string
  /**
   * Explicit bind port. HUB ONLY — a runner binds nothing (it dials out), so this
   * is ignored for `kind: 'runner'`. Omitted on a hub ⇒ the hub picks a free port
   * from the hub block itself, which is the normal case.
   *
   * @deprecated Prefer {@link address}. Kept because it renders the historical
   * `127.0.0.1:<port>` form that existing callers and their specs depend on —
   * a loopback bind is still the right default for a local hub.
   */
  port?: number
  /** Extra environment for the unit, on top of the SlayZone vars below. Needed when
   *  the interpreter itself requires configuring — e.g. a dev-tree hub or runner
   *  whose native addons are Electron-ABI must run under
   *  `ELECTRON_RUN_AS_NODE=1 electron`. Keys here win over the defaults. */
  env?: Record<string, string>
}

/**
 * Per-kind identity. The prefixes reach a FILENAME and a launchd Label, so they are
 * also what keeps the two kinds' units from ever being mistaken for one another —
 * `listRegisteredUnits('runner')` will not see a hub, and vice versa.
 */
const KINDS = {
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
  runner: {
    labelPrefix: 'com.slayzone.runner.',
    systemdPrefix: 'slayzone-runner-',
    description: 'SlayZone runner',
    outLog: 'runner.out.log',
    errLog: 'runner.err.log',
    logsCommand: 'slay runner logs',
    renameHint: 'Pick a different name for `slay runner create`.'
  }
} as const satisfies Record<ServiceKind, unknown>

/**
 * Service names allowed in a unit filename.
 *
 * Deliberately strict: the name reaches a FILE PATH and the INTERIOR of a unit file,
 * so `..`/`/` would let `create` write outside the unit dir, and a newline would
 * inject arbitrary directives (`Restart=always`) into a systemd unit. Letters,
 * digits, dot, dash and underscore cover every name a hub or runner actually gets
 * (hub default: a directory basename), and a leading dot is refused so a name can
 * never be `.` or `..`.
 */
function isValidServiceName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name)
}

function assertValidServiceName(kind: ServiceKind, name: string): void {
  if (!isValidServiceName(name)) {
    throw new Error(
      `[slayzone] invalid ${kind} name ${JSON.stringify(name)} — a name may contain only ` +
        `letters, digits, dot, dash and underscore (no slashes, spaces or newlines), ` +
        `and must not start with a dot. ${KINDS[kind].renameHint}`
    )
  }
}

/** The default unit directory for a backend (the only dir it reads). */
export function defaultUnitDir(backend: ServiceBackend): string {
  const home = process.env.HOME ?? homedir()
  if (backend === 'launchd') return join(home, 'Library', 'LaunchAgents')
  if (backend === 'systemd') return join(home, '.config', 'systemd', 'user')
  throw new Error('[slayzone] no unit directory: this platform has no user service backend')
}

/**
 * Which supervisor to use here.
 *
 * macOS always has launchd. On Linux, systemd --user only counts when
 * `systemctl` exists AND a user bus is reachable — a container without one would
 * accept the file and never run it, which is worse than admitting `none`.
 */
export function detectBackend(): ServiceBackend {
  if (process.platform === 'darwin') return 'launchd'
  if (process.platform === 'win32') return 'none'
  // Must exercise the USER BUS, not merely find the binary. `systemctl --user
  // --version` prints a version without contacting anything, so it succeeds on a
  // VPS or container that has no user session — and then every real `--user` call
  // fails with "Failed to connect to bus: No medium found", after we have already
  // written a unit file. `is-system-running` performs a real bus round-trip.
  //
  // Its exit code is non-zero for states that are perfectly usable (`degraded`
  // when some unrelated unit failed), so the STDOUT state is what decides:
  // any state at all ⇒ the bus answered ⇒ systemd is usable.
  try {
    const out = execFileSync('systemctl', ['--user', 'is-system-running'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return out.trim().length > 0 ? 'systemd' : 'none'
  } catch (e) {
    const err = e as { stdout?: string | Buffer; status?: number | null }
    // A non-zero exit that still reported a state means the bus is there.
    const state = (typeof err.stdout === 'string' ? err.stdout : err.stdout?.toString() ?? '').trim()
    if (state && !/^(offline|unknown)$/i.test(state)) return 'systemd'
    return 'none'
  }
}

/**
 * Absolute path of the unit file for `(kind, name)`. Deterministic — `start` and
 * `stop` derive the same path from the same inputs, so they can never disagree about
 * which file to touch. Throws on an unsafe name (see {@link isValidServiceName}).
 */
export function unitPath(
  kind: ServiceKind,
  name: string,
  backend: Exclude<ServiceBackend, 'none'>,
  unitDir: string = defaultUnitDir(backend)
): string {
  assertValidServiceName(kind, name)
  return backend === 'launchd'
    ? join(unitDir, `${KINDS[kind].labelPrefix}${name}.plist`)
    : join(unitDir, `${KINDS[kind].systemdPrefix}${name}.service`)
}

/** Recover the service name from a unit filename, or null when it isn't this kind's. */
function nameFromUnitFile(
  kind: ServiceKind,
  file: string,
  backend: Exclude<ServiceBackend, 'none'>
): string | null {
  if (backend === 'launchd') {
    const prefix = KINDS[kind].labelPrefix
    if (!file.startsWith(prefix) || !file.endsWith('.plist')) return null
    return file.slice(prefix.length, -'.plist'.length) || null
  }
  const prefix = KINDS[kind].systemdPrefix
  if (!file.startsWith(prefix) || !file.endsWith('.service')) return null
  return file.slice(prefix.length, -'.service'.length) || null
}

/** XML text escape for plist string values. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The environment a supervised process needs. launchd hands an agent a nearly empty
 * env, so anything the process must see is pinned here rather than inherited.
 *
 * The two kinds pin different sets, and the RUNNER's is deliberately minimal: its
 * display name, filesystem path-jail, join token and cert pin have NO env channel at
 * all (see `runner/src/config.ts`) — they come from `<ROOT>/config.json`, which is
 * 0600. A unit file is 0644 and world-readable, so a join token must never be
 * written into one. Pinning ROOT is what points the runner at that config.
 */
function unitEnv(spec: ServiceUnitSpec): Array<[string, string]> {
  const merged: Record<string, string> = { SLAYZONE_ROOT: spec.root }
  if (spec.kind === 'hub') {
    merged.SLAYZONE_HUB_NAME = spec.name
    // Only when explicitly requested: with no address the hub takes the first free
    // port in the hub block, which is what makes several hubs coexist unattended.
    //
    // `address` wins over `port`: it is the only one that can name a non-loopback
    // bind, so letting `port` win would silently pin a remote hub to loopback and
    // make it unreachable. `port` keeps rendering the historical loopback form.
    if (spec.address !== undefined) merged.SLAYZONE_HUB_ADDRESS = spec.address
    else if (spec.port !== undefined) merged.SLAYZONE_HUB_ADDRESS = `127.0.0.1:${spec.port}`
  }
  // Caller-supplied last so it can set interpreter-level vars (ELECTRON_RUN_AS_NODE)
  // and, deliberately, override a default if it must.
  Object.assign(merged, spec.env ?? {})
  return Object.entries(merged)
}

/**
 * Render the launchd plist.
 *
 * `KeepAlive.SuccessfulExit = false` is the crux: relaunch after a CRASH, stay
 * down after a clean exit. A bare `KeepAlive: true` would resurrect the process
 * immediately after `slay hub stop` / `slay runner stop`, making the stop command
 * look broken.
 */
export function renderLaunchdPlist(spec: ServiceUnitSpec): string {
  assertValidServiceName(spec.kind, spec.name)
  const kind = KINDS[spec.kind]
  const programArgs = [spec.command, ...spec.args]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n')
  const envEntries = unitEnv(spec)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${kind.labelPrefix}${spec.name}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(spec.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(spec.logDir, kind.outLog))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(spec.logDir, kind.errLog))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`
}

/**
 * Render the systemd user unit.
 *
 * One unit per hub/runner rather than a `@`-template instance: the template form
 * would have to derive SLAYZONE_ROOT from the instance name, which cannot express an
 * arbitrary path. `Restart=on-failure` mirrors the launchd choice — a clean `stop`
 * must stay stopped. `[Install]` is required or `systemctl enable` has nothing to
 * link.
 */
export function renderSystemdUnit(spec: ServiceUnitSpec): string {
  assertValidServiceName(spec.kind, spec.name)
  const kind = KINDS[spec.kind]
  const exec = [spec.command, ...spec.args].join(' ')
  const envLines = unitEnv(spec)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join('\n')
  return `[Unit]
Description=${kind.description} (${spec.name})
Documentation=https://github.com/debuglebowski/slayzone
After=network.target

[Service]
Type=simple
WorkingDirectory=${spec.root}
${envLines}
ExecStart=${exec}
Restart=on-failure
RestartSec=2
# stdout/stderr go to journald; read them with \`${kind.logsCommand} ${spec.name}\`.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`
}

/**
 * Write (or replace) the unit file for `spec`. Returns its path.
 *
 * Registration with the supervisor is a separate step the CLI performs, so this
 * stays pure filesystem work and is safe to unit-test.
 */
export function writeUnit(
  spec: ServiceUnitSpec,
  backend: Exclude<ServiceBackend, 'none'>,
  unitDir: string = defaultUnitDir(backend)
): string {
  const path = unitPath(spec.kind, spec.name, backend, unitDir)
  mkdirSync(unitDir, { recursive: true })
  const content = backend === 'launchd' ? renderLaunchdPlist(spec) : renderSystemdUnit(spec)
  writeFileSync(path, content, { mode: 0o644 })
  return path
}

/** Delete a unit file. Returns false when there was none (idempotent). */
export function removeUnit(
  kind: ServiceKind,
  name: string,
  backend: Exclude<ServiceBackend, 'none'>,
  unitDir: string = defaultUnitDir(backend)
): boolean {
  const path = unitPath(kind, name, backend, unitDir)
  if (!existsSync(path)) return false
  rmSync(path, { force: true })
  return true
}

/**
 * Every hub (or runner) registered with this backend, by unit filename.
 *
 * A missing unit dir is an empty list, not an error — a machine that has never run
 * `create` simply has none. Foreign units in the directory (a real LaunchAgents dir
 * is full of them) are ignored by prefix, which is also what keeps the two SlayZone
 * kinds from listing each other.
 */
export function listRegisteredUnits(
  kind: ServiceKind,
  backend: Exclude<ServiceBackend, 'none'>,
  unitDir: string = defaultUnitDir(backend)
): Array<{ name: string; unitPath: string }> {
  let files: string[]
  try {
    files = readdirSync(unitDir)
  } catch {
    return []
  }
  const out: Array<{ name: string; unitPath: string }> = []
  for (const file of files) {
    const name = nameFromUnitFile(kind, file, backend)
    if (name) out.push({ name, unitPath: join(unitDir, file) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The `SLAYZONE_ROOT` a registered hub/runner was created with, read back out of its
 * unit file — or null when there is no unit (or it is unreadable).
 *
 * `start`/`rm` act on a process that may be STOPPED, so its root cannot come from
 * `/health` the way a running hub's does — and a runner never has a `/health` at all
 * (it dials out), so its unit is the ONLY machine-side record of where it lives. The
 * unit is the record of what `create` decided, which is exactly what those commands
 * must reuse (log paths, restart with the same anchor).
 */
export function readUnitRoot(
  kind: ServiceKind,
  name: string,
  backend: Exclude<ServiceBackend, 'none'>,
  unitDir: string = defaultUnitDir(backend)
): string | null {
  let text: string
  try {
    text = readFileSync(unitPath(kind, name, backend, unitDir), 'utf8')
  } catch {
    return null
  }
  const match =
    backend === 'launchd'
      ? /<key>SLAYZONE_ROOT<\/key>\s*<string>([^<]*)<\/string>/.exec(text)
      : /^Environment=SLAYZONE_ROOT=(.*)$/m.exec(text)
  const raw = match?.[1]?.trim()
  if (!raw) return null
  // Undo the XML escaping renderLaunchdPlist applied.
  return backend === 'launchd'
    ? raw
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
    : raw
}

/**
 * The launchd stdout/stderr capture filenames for a kind.
 *
 * Exported because the CALLER needs the same two names the plist points at: the
 * unsupervised (`backend === 'none'`) fallback spawn redirects into them by hand, and
 * a failed boot is reported by quoting the tail of one. Deriving them independently
 * would let the reader and the writer drift onto different files, which reads as
 * "no output was captured".
 */
export function serviceLogNames(kind: ServiceKind): { out: string; err: string } {
  return { out: KINDS[kind].outLog, err: KINDS[kind].errLog }
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
