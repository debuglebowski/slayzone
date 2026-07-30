/**
 * Hand a hub to the OS supervisor so it stays up.
 *
 * `slay hub start` does not merely background the hub — a detached spawn dies for
 * good on the first crash and never returns after a logout. Both mainstream OSes
 * already ship a supervisor that solves exactly this from a small declarative
 * file: launchd (macOS) and systemd --user (Linux). This module renders and
 * installs that file; the supervisor then owns restart-on-crash,
 * start-at-login, and log redirection. Nothing here reimplements supervision.
 *
 * SCOPE OF THE GUARANTEE (say this accurately to operators): a launchd *user
 * agent* and a lingering systemd *user unit* restart the hub on crash and start
 * it at LOGIN. Starting before any login needs a root-owned
 * `/Library/LaunchDaemons` plist or a systemd *system* unit — sudo territory, not
 * done here. Windows has no user-level equivalent, so `detectBackend()` returns
 * `'none'` and the caller falls back to a bare detached spawn.
 *
 * WHERE THE FILES GO. `~/Library/LaunchAgents` and `~/.config/systemd/user` are
 * the only directories those supervisors read, so the unit necessarily lives
 * outside the hub's own ROOT. That is OS registration, not SlayZone state — no
 * SlayZone data leaves `<ROOT>`; the unit merely points at it.
 *
 * WHY THE COMMAND IS ABSOLUTE. The unit pins a resolved interpreter + script path
 * rather than `npx @slayzone/hub`: the supervisor re-executes this command on
 * every crash and at every login, and an `npx` there would mean a registry
 * round-trip (and a silent version drift) per restart. `slay hub restart
 * --upgrade` re-resolves deliberately.
 *
 * Lean leaf (node builtins + ./dirs only) so the CLI bundle can import
 * `@slayzone/platform/hub-service` without the platform barrel.
 *
 * @module platform/hub-service
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Which OS supervisor is available. `none` ⇒ caller must fall back. */
export type ServiceBackend = 'launchd' | 'systemd' | 'none'

/** Everything a unit file needs to run one hub. */
export interface HubServiceSpec {
  /** Hub name — the unit's identity. Must satisfy {@link isValidHubName}. */
  name: string
  /** SLAYZONE_ROOT: the hub's anchor, pinned into the unit's environment. */
  root: string
  /** Absolute interpreter/binary path (never `npx` — see the module note). */
  command: string
  /** Arguments after `command`. */
  args: string[]
  /** Directory for the supervisor's stdout/stderr capture (launchd only; systemd
   *  uses journald). */
  logDir: string
  /** Explicit bind port. Omitted ⇒ the hub picks a free port from the hub block
   *  itself, which is the normal case. */
  port?: number
  /** Extra environment for the unit, on top of the SlayZone vars below. Needed
   *  when the interpreter itself requires configuring — e.g. a dev-tree hub whose
   *  native addons are Electron-ABI must run under
   *  `ELECTRON_RUN_AS_NODE=1 electron`. Keys here win over the defaults. */
  env?: Record<string, string>
}

/** launchd label / systemd unit-name prefix. */
const LABEL_PREFIX = 'com.slayzone.hub.'
const SYSTEMD_PREFIX = 'slayzone-hub-'

/**
 * Hub names allowed in a unit filename.
 *
 * Deliberately strict: the name reaches a FILE PATH and the INTERIOR of a unit
 * file, so `..`/`/` would let `hub start` write outside the unit dir, and a
 * newline would inject arbitrary directives (`Restart=always`) into a systemd
 * unit. Letters, digits, dot, dash and underscore cover every name a hub actually
 * gets (default: a directory basename), and a leading dot is refused so a name
 * can never be `.` or `..`.
 */
function isValidHubName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name)
}

function assertValidHubName(name: string): void {
  if (!isValidHubName(name)) {
    throw new Error(
      `[slayzone] invalid hub name ${JSON.stringify(name)} — a name may contain only ` +
        `letters, digits, dot, dash and underscore (no slashes, spaces or newlines), ` +
        `and must not start with a dot. Rename with \`--name\` or the config.json ` +
        `\`hubName\` key.`
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
 * Absolute path of the unit file for `name`. Deterministic — `start` and `stop`
 * derive the same path from the same name, so they can never disagree about which
 * file to touch. Throws on an unsafe name (see {@link isValidHubName}).
 */
export function hubUnitPath(
  name: string,
  backend: Exclude<ServiceBackend, 'none'>,
  unitDir: string = defaultUnitDir(backend)
): string {
  assertValidHubName(name)
  return backend === 'launchd'
    ? join(unitDir, `${LABEL_PREFIX}${name}.plist`)
    : join(unitDir, `${SYSTEMD_PREFIX}${name}.service`)
}

/** Recover the hub name from a unit filename, or null when it isn't ours. */
function nameFromUnitFile(file: string, backend: Exclude<ServiceBackend, 'none'>): string | null {
  if (backend === 'launchd') {
    if (!file.startsWith(LABEL_PREFIX) || !file.endsWith('.plist')) return null
    return file.slice(LABEL_PREFIX.length, -'.plist'.length) || null
  }
  if (!file.startsWith(SYSTEMD_PREFIX) || !file.endsWith('.service')) return null
  return file.slice(SYSTEMD_PREFIX.length, -'.service'.length) || null
}

/** XML text escape for plist string values. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** The environment a supervised hub needs. launchd hands an agent a nearly empty
 *  env, so anything the hub must see is pinned here rather than inherited. */
function hubEnv(spec: HubServiceSpec): Array<[string, string]> {
  const merged: Record<string, string> = {
    SLAYZONE_ROOT: spec.root,
    SLAYZONE_HUB_NAME: spec.name
  }
  // Only when explicitly requested: with no address the hub takes the first free
  // port in the hub block, which is what makes several hubs coexist unattended.
  if (spec.port !== undefined) merged.SLAYZONE_HUB_ADDRESS = `127.0.0.1:${spec.port}`
  // Caller-supplied last so it can set interpreter-level vars (ELECTRON_RUN_AS_NODE)
  // and, deliberately, override a default if it must.
  Object.assign(merged, spec.env ?? {})
  return Object.entries(merged)
}

/**
 * Render the launchd plist.
 *
 * `KeepAlive.SuccessfulExit = false` is the crux: relaunch after a CRASH, stay
 * down after a clean exit. A bare `KeepAlive: true` would resurrect the hub
 * immediately after `slay hub stop`, making the stop command look broken.
 */
export function renderLaunchdPlist(spec: HubServiceSpec): string {
  assertValidHubName(spec.name)
  const programArgs = [spec.command, ...spec.args]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n')
  const envEntries = hubEnv(spec)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL_PREFIX}${spec.name}</string>
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
  <string>${xmlEscape(join(spec.logDir, 'hub.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(spec.logDir, 'hub.err.log'))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`
}

/**
 * Render the systemd user unit.
 *
 * One unit per hub rather than a `@`-template instance: the template form would
 * have to derive SLAYZONE_ROOT from the instance name, which cannot express an
 * arbitrary path. `Restart=on-failure` mirrors the launchd choice — a clean
 * `hub stop` must stay stopped. `[Install]` is required or `systemctl enable` has
 * nothing to link.
 */
export function renderSystemdUnit(spec: HubServiceSpec): string {
  assertValidHubName(spec.name)
  const exec = [spec.command, ...spec.args].join(' ')
  const envLines = hubEnv(spec)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join('\n')
  return `[Unit]
Description=SlayZone hub (${spec.name})
Documentation=https://github.com/debuglebowski/slayzone
After=network.target

[Service]
Type=simple
WorkingDirectory=${spec.root}
${envLines}
ExecStart=${exec}
Restart=on-failure
RestartSec=2
# stdout/stderr go to journald; read them with \`slay hub logs ${spec.name}\`.
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
export function writeHubUnit(
  spec: HubServiceSpec,
  backend: Exclude<ServiceBackend, 'none'>,
  unitDir: string = defaultUnitDir(backend)
): string {
  const path = hubUnitPath(spec.name, backend, unitDir)
  mkdirSync(unitDir, { recursive: true })
  const content = backend === 'launchd' ? renderLaunchdPlist(spec) : renderSystemdUnit(spec)
  writeFileSync(path, content, { mode: 0o644 })
  return path
}

/** Delete a hub's unit file. Returns false when there was none (idempotent). */
export function removeHubUnit(
  name: string,
  backend: Exclude<ServiceBackend, 'none'>,
  unitDir: string = defaultUnitDir(backend)
): boolean {
  const path = hubUnitPath(name, backend, unitDir)
  if (!existsSync(path)) return false
  rmSync(path, { force: true })
  return true
}

/**
 * Every hub registered with this backend, by unit filename.
 *
 * A missing unit dir is an empty list, not an error — a machine that has never
 * run `hub start` simply has none. Foreign units in the directory (a real
 * LaunchAgents dir is full of them) are ignored by prefix.
 */
export function listRegisteredHubs(
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
    const name = nameFromUnitFile(file, backend)
    if (name) out.push({ name, unitPath: join(unitDir, file) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The `SLAYZONE_ROOT` a registered hub was created with, read back out of its unit
 * file — or null when there is no unit (or it is unreadable).
 *
 * `hub start`/`rm` act on a hub that may be STOPPED, so its root cannot come from
 * `/health` the way a running hub's does. The unit is the record of what `create`
 * decided, which is exactly what those commands must reuse (log paths, restart
 * with the same anchor).
 */
export function readHubUnitRoot(
  name: string,
  backend: Exclude<ServiceBackend, 'none'>,
  unitDir: string = defaultUnitDir(backend)
): string | null {
  let text: string
  try {
    text = readFileSync(hubUnitPath(name, backend, unitDir), 'utf8')
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

/** The systemd unit name (not path) for `systemctl --user` arguments. */
export function systemdUnitName(name: string): string {
  assertValidHubName(name)
  return `${SYSTEMD_PREFIX}${name}.service`
}

/** The launchd label for `launchctl` arguments. */
export function launchdLabel(name: string): string {
  assertValidHubName(name)
  return `${LABEL_PREFIX}${name}`
}
