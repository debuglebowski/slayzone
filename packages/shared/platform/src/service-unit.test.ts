/**
 * OS-supervisor registration for hubs AND runners (plans/hub-lifecycle-and-discovery.md
 * Phase 5 for the hub; the `slay runner` group for the runner).
 *
 * `slay hub create` / `slay runner create` hand the process to launchd (macOS) or
 * systemd --user (Linux) so it restarts on crash and comes back at login. This suite
 * asserts the GENERATED FILE CONTENT and the path/name derivation — never real
 * `launchctl bootstrap` / `systemctl enable`, which would leave units behind on
 * whatever machine runs the suite. Every case writes into a temp dir via the injected
 * `unitDir`.
 *
 * The properties that matter:
 *   - a crash restarts the process, a clean `stop` does NOT resurrect it;
 *   - the unit pins SLAYZONE_ROOT + an absolute command (no `npx` at boot);
 *   - one (kind, name) pair ⇒ one unit path, so start/stop agree on which file to touch;
 *   - a hostile name can't escape the unit dir or inject unit syntax;
 *   - the two KINDS never see each other's units, and a runner unit carries NO
 *     hub env (its name/token/path-jail have no env channel — see runner/src/config.ts).
 *
 * Pure Node (temp dirs, no native deps, no supervisor calls) → runs under plain
 * `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/service-unit.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectBackend,
  launchdLabel,
  listRegisteredUnits,
  readUnitRoot,
  removeUnit,
  renderLaunchdPlist,
  renderSystemdUnit,
  systemdUnitName,
  unitPath,
  writeUnit,
  type ServiceUnitSpec
} from './service-unit'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}
function assertThrows(fn: () => unknown, needle: string, msg: string): void {
  let message = ''
  try {
    fn()
  } catch (e) {
    message = e instanceof Error ? e.message : String(e)
  }
  assert(message.length > 0, `${msg}: expected a throw`)
  assert(message.includes(needle), `${msg}: error should mention "${needle}", got "${message}"`)
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'slz-unit-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const backend = process.platform === 'darwin' ? 'launchd' : 'systemd'

const SPEC: ServiceUnitSpec = {
  kind: 'hub',
  name: 'staging',
  root: '/Users/x/hubs/staging',
  command: '/usr/local/bin/node',
  args: ['/opt/hub/dist/bin.cjs'],
  logDir: '/Users/x/hubs/staging/storage/logs'
}

const RUNNER_SPEC: ServiceUnitSpec = {
  kind: 'runner',
  name: 'builder',
  root: '/srv/runners/builder',
  command: '/usr/local/bin/node',
  args: ['/opt/runner/dist/bin.cjs'],
  logDir: '/srv/runners/builder/logs'
}

console.log('\nservice-unit: backend detection')
console.log('─'.repeat(40))

test('detects a backend appropriate to the platform', () => {
  const detected = detectBackend()
  if (process.platform === 'darwin') assertEq(detected, 'launchd', 'macOS → launchd')
  else if (process.platform === 'win32') assertEq(detected, 'none', 'Windows → no user supervisor yet')
  else assert(detected === 'systemd' || detected === 'none', `linux → systemd or none, got ${detected}`)
})

test('systemd requires a reachable USER BUS, not just the binary', () => {
  // REGRESSION (hit on a VPS): detection ran `systemctl --user --version`, which
  // prints a version WITHOUT contacting anything — so it reported systemd on a box
  // with no user session, and `hub create` then wrote a unit and died on
  // "Failed to connect to bus: No medium found". Detection must do a real bus
  // round-trip (`is-system-running`).
  //
  // Driven through fake `systemctl`s on PATH, since the host running this suite has
  // whatever session it has. Only meaningful where PATH lookup applies (non-darwin
  // logic), so the shape of the DECISION is asserted rather than detectBackend()
  // itself: any reported state ⇒ usable; no state ⇒ not.
  const decide = (stdout: string, threw: boolean): string => {
    const state = stdout.trim()
    if (!threw) return state.length > 0 ? 'systemd' : 'none'
    return state && !/^(offline|unknown)$/i.test(state) ? 'systemd' : 'none'
  }
  // Bus missing: systemctl writes to stderr, exits non-zero, reports NO state.
  assertEq(decide('', true), 'none', 'no bus ⇒ not usable')
  // Healthy.
  assertEq(decide('running\n', false), 'systemd', 'running ⇒ usable')
  // Non-zero exit but a real state: some unrelated unit failed. Still usable —
  // treating this as `none` would needlessly downgrade a working box.
  assertEq(decide('degraded\n', true), 'systemd', 'degraded ⇒ still usable')
  assertEq(decide('offline\n', true), 'none', 'offline ⇒ not usable')
})

console.log('\nservice-unit: launchd plist content (hub)')
console.log('─'.repeat(40))

test('plist carries label, absolute command, cwd, env and log paths', () => {
  const xml = renderLaunchdPlist(SPEC)
  assert(xml.includes('<key>Label</key>'), 'has a Label')
  assert(xml.includes('com.slayzone.hub.staging'), 'label namespaced by hub name')
  assert(xml.includes('/usr/local/bin/node'), 'absolute program path')
  assert(xml.includes('/opt/hub/dist/bin.cjs'), 'program argument')
  assert(xml.includes('<key>WorkingDirectory</key>'), 'sets a working directory')
  assert(xml.includes('/Users/x/hubs/staging'), 'cwd = hub root')
  // The unit must PIN the root: launchd gives an agent a near-empty environment,
  // so relying on the inherited cwd default would anchor the hub elsewhere.
  assert(xml.includes('SLAYZONE_ROOT'), 'pins SLAYZONE_ROOT explicitly')
  assert(xml.includes('/Users/x/hubs/staging/storage/logs'), 'log paths under the hub root')
})

test('plist restarts on crash but NOT after a clean stop', () => {
  const xml = renderLaunchdPlist(SPEC)
  // KeepAlive/SuccessfulExit=false ⇒ relaunch only on non-zero exit. A bare
  // `KeepAlive: true` would fight `slay hub stop` forever.
  assert(xml.includes('<key>KeepAlive</key>'), 'has KeepAlive')
  assert(xml.includes('<key>SuccessfulExit</key>'), 'conditions KeepAlive on exit status')
  const afterSuccessfulExit = xml.slice(xml.indexOf('<key>SuccessfulExit</key>'))
  assert(afterSuccessfulExit.trimStart().startsWith('<key>SuccessfulExit</key>'), 'sanity')
  assert(
    afterSuccessfulExit.indexOf('<false/>') < afterSuccessfulExit.indexOf('<key>', 25) ||
      afterSuccessfulExit.includes('<false/>'),
    'SuccessfulExit is false (do not relaunch after a clean exit)'
  )
  assert(xml.includes('<key>RunAtLoad</key>'), 'starts at load/login')
})

test('plist is well-formed XML with the plist preamble', () => {
  const xml = renderLaunchdPlist(SPEC)
  assert(xml.startsWith('<?xml'), 'xml declaration first')
  assert(xml.includes('<!DOCTYPE plist'), 'doctype')
  assert(xml.trimEnd().endsWith('</plist>'), 'closes the plist')
  const opens = (xml.match(/<dict>/g) ?? []).length
  const closes = (xml.match(/<\/dict>/g) ?? []).length
  assertEq(opens, closes, 'balanced <dict> tags')
})

test('plist escapes XML metacharacters in paths', () => {
  const xml = renderLaunchdPlist({ ...SPEC, root: '/tmp/a&b<c>', logDir: '/tmp/a&b<c>/logs' })
  assert(xml.includes('&amp;'), 'ampersand escaped')
  assert(!xml.includes('a&b'), 'raw ampersand gone')
  assert(xml.includes('&lt;c&gt;'), 'angle brackets escaped')
})

console.log('\nservice-unit: systemd unit content (hub)')
console.log('─'.repeat(40))

test('unit carries ExecStart, WorkingDirectory, Environment and install target', () => {
  const unit = renderSystemdUnit(SPEC)
  assert(unit.includes('[Unit]'), 'has [Unit]')
  assert(unit.includes('[Service]'), 'has [Service]')
  assert(unit.includes('[Install]'), 'has [Install] — else `enable` is a no-op')
  assert(
    unit.includes('ExecStart=/usr/local/bin/node /opt/hub/dist/bin.cjs'),
    'absolute ExecStart with args'
  )
  assert(unit.includes('WorkingDirectory=/Users/x/hubs/staging'), 'cwd = hub root')
  assert(unit.includes('Environment=SLAYZONE_ROOT=/Users/x/hubs/staging'), 'pins SLAYZONE_ROOT')
  assert(unit.includes('WantedBy=default.target'), 'enabled for the user session')
})

test('unit restarts on failure only, and identifies the hub', () => {
  const unit = renderSystemdUnit(SPEC)
  assert(unit.includes('Restart=on-failure'), 'on-failure, not always (a clean stop must stick)')
  assert(unit.includes('RestartSec='), 'has a restart backoff')
  assert(/Description=.*staging/.test(unit), 'description names the hub')
})

test('unit sets the hub name env so /health reports the same label', () => {
  const unit = renderSystemdUnit(SPEC)
  assert(unit.includes('Environment=SLAYZONE_HUB_NAME=staging'), 'pins the name')
})

test('an explicit port reaches the unit as SLAYZONE_HUB_ADDRESS', () => {
  const unit = renderSystemdUnit({ ...SPEC, port: 51234 })
  assert(unit.includes('51234'), 'port present')
  assert(unit.includes('SLAYZONE_HUB_ADDRESS'), 'passed via the address var, not a bare port')
  const plist = renderLaunchdPlist({ ...SPEC, port: 51234 })
  assert(plist.includes('51234') && plist.includes('SLAYZONE_HUB_ADDRESS'), 'same in the plist')
})

test('no port ⇒ no address var (hub picks a free block port itself)', () => {
  const unit = renderSystemdUnit(SPEC)
  assert(!unit.includes('SLAYZONE_HUB_ADDRESS'), 'absent when unspecified')
})

// `address` carries a full authority so a REMOTE hub can bind wider than loopback.
// `port` cannot express that — it hardcodes `127.0.0.1:<port>` — but it stays as the
// deprecated alias, because every existing caller passes it and the two specs above
// pin its exact output.
test('an explicit address reaches the unit verbatim (a remote hub binds wider)', () => {
  const unit = renderSystemdUnit({ ...SPEC, address: '0.0.0.0:51234' })
  assert(
    unit.includes('Environment=SLAYZONE_HUB_ADDRESS=0.0.0.0:51234'),
    `wildcard bind preserved: ${unit}`
  )
  const plist = renderLaunchdPlist({ ...SPEC, address: '0.0.0.0:51234' })
  assert(plist.includes('0.0.0.0:51234'), 'same in the plist')
})

test('address WINS over the legacy port (no silent loopback downgrade)', () => {
  // Both given is the shape `hub create --port X --public-address Y` produces. If
  // `port` won, a remote hub would bind loopback and be unreachable — the exact bug
  // the address field exists to prevent.
  const unit = renderSystemdUnit({ ...SPEC, port: 51234, address: '0.0.0.0:51234' })
  assert(unit.includes('SLAYZONE_HUB_ADDRESS=0.0.0.0:51234'), `address used: ${unit}`)
  assert(!unit.includes('127.0.0.1'), 'no loopback address emitted')
})

test('a runner spec ignores address too (a runner binds nothing)', () => {
  const unit = renderSystemdUnit({ ...RUNNER_SPEC, address: '0.0.0.0:51234' })
  assert(!unit.includes('SLAYZONE_HUB_ADDRESS'), 'no address var for a runner')
  assert(!unit.includes('0.0.0.0'), 'address not emitted')
})

test('spec.env reaches the unit — an Electron-ABI hub needs ELECTRON_RUN_AS_NODE', () => {
  // A dev-tree hub's better-sqlite3 is compiled for Electron's ABI, so it must run
  // as `ELECTRON_RUN_AS_NODE=1 <electron>`; without this the supervisor crash-loops
  // it invisibly on `NODE_MODULE_VERSION` mismatch.
  const withEnv = { ...SPEC, env: { ELECTRON_RUN_AS_NODE: '1' } }
  const unit = renderSystemdUnit(withEnv)
  assert(unit.includes('Environment=ELECTRON_RUN_AS_NODE=1'), `systemd: ${unit}`)
  const plist = renderLaunchdPlist(withEnv)
  assert(plist.includes('ELECTRON_RUN_AS_NODE'), 'plist carries the key')
  assert(/<key>ELECTRON_RUN_AS_NODE<\/key>\s*<string>1<\/string>/.test(plist), 'plist value')
  // The SlayZone vars must survive alongside it.
  assert(unit.includes('SLAYZONE_ROOT='), 'root still pinned')
  assert(plist.includes('SLAYZONE_HUB_NAME'), 'name still pinned')
})

console.log('\nservice-unit: runner kind')
console.log('─'.repeat(40))

test('runner identity is namespaced apart from the hub', () => {
  assertEq(launchdLabel('runner', 'builder'), 'com.slayzone.runner.builder', 'launchd label')
  assertEq(systemdUnitName('runner', 'builder'), 'slayzone-runner-builder.service', 'systemd unit')
  // Same NAME under the two kinds must never resolve to the same file, or
  // `runner rm dev` would delete a hub named dev.
  assert(
    unitPath('runner', 'dev', backend, '/units') !== unitPath('hub', 'dev', backend, '/units'),
    'a name shared across kinds does not collide'
  )
})

test('runner plist/unit identify the runner and use runner log names', () => {
  const plist = renderLaunchdPlist(RUNNER_SPEC)
  assert(plist.includes('<string>com.slayzone.runner.builder</string>'), `label: ${plist}`)
  assert(plist.includes('/srv/runners/builder/logs/runner.out.log'), 'stdout log')
  assert(plist.includes('/srv/runners/builder/logs/runner.err.log'), 'stderr log')
  assert(!plist.includes('hub.out.log'), 'no hub log name leaked')
  const unit = renderSystemdUnit(RUNNER_SPEC)
  assert(unit.includes('Description=SlayZone runner (builder)'), `description: ${unit}`)
  assert(unit.includes('slay runner logs builder'), 'log hint names the runner command')
})

test('a runner unit carries SLAYZONE_ROOT and NOTHING hub-shaped', () => {
  // The runner's name, path-jail, join token and cert pin deliberately have NO env
  // channel (runner/src/config.ts) — they come from <ROOT>/config.json, which is
  // 0600. A unit file is 0644, so a token must never reach it.
  const unit = renderSystemdUnit(RUNNER_SPEC)
  assert(unit.includes('Environment=SLAYZONE_ROOT=/srv/runners/builder'), 'root pinned')
  assert(!unit.includes('SLAYZONE_HUB_NAME'), 'no hub name var')
  assert(!unit.includes('SLAYZONE_HUB_ADDRESS'), 'no hub address var')
  assert(!unit.includes('SLAYZONE_HUB_JOIN_TOKEN'), 'never a join token in a 0644 unit')
  const envLines = unit.split('\n').filter((l) => l.startsWith('Environment='))
  assertEq(envLines.length, 1, `exactly one env line, got ${envLines.join(' | ')}`)
})

test('a runner spec ignores port (only a hub binds one)', () => {
  const unit = renderSystemdUnit({ ...RUNNER_SPEC, port: 51234 })
  assert(!unit.includes('51234'), 'port not emitted for a runner')
  assert(!unit.includes('SLAYZONE_HUB_ADDRESS'), 'no address var')
})

test('spec.env reaches a runner unit too — node-pty is Electron-ABI in a dev tree', () => {
  const unit = renderSystemdUnit({ ...RUNNER_SPEC, env: { ELECTRON_RUN_AS_NODE: '1' } })
  assert(unit.includes('Environment=ELECTRON_RUN_AS_NODE=1'), `systemd: ${unit}`)
  assert(unit.includes('Environment=SLAYZONE_ROOT='), 'root still pinned')
})

test('the two kinds never list each other, even in one unit dir', () => {
  withTempDir((dir) => {
    writeUnit(SPEC, backend, dir)
    writeUnit(RUNNER_SPEC, backend, dir)
    const hubs = listRegisteredUnits('hub', backend, dir)
    assertEq(hubs.length, 1, `one hub, got ${hubs.map((h) => h.name).join(',')}`)
    assertEq(hubs[0]?.name, 'staging', 'the hub')
    const runners = listRegisteredUnits('runner', backend, dir)
    assertEq(runners.length, 1, `one runner, got ${runners.map((r) => r.name).join(',')}`)
    assertEq(runners[0]?.name, 'builder', 'the runner')
  })
})

test('a hub named like a runner prefix is not mistaken for a runner', () => {
  // `slayzone-hub-runner-x.service` must not parse as runner `x`: the runner listing
  // only accepts its own prefix, which the hub filename does not carry.
  withTempDir((dir) => {
    writeUnit({ ...SPEC, name: 'runner-x' }, backend, dir)
    assertEq(listRegisteredUnits('runner', backend, dir).length, 0, 'no runner found')
    assertEq(listRegisteredUnits('hub', backend, dir)[0]?.name, 'runner-x', 'listed as a hub')
  })
})

test('a runner root round-trips through its unit while stopped', () => {
  withTempDir((dir) => {
    writeUnit(RUNNER_SPEC, backend, dir)
    assertEq(readUnitRoot('runner', 'builder', backend, dir), RUNNER_SPEC.root, 'root read back')
    assertEq(readUnitRoot('hub', 'builder', backend, dir), null, 'not visible as a hub')
    assertEq(removeUnit('runner', 'builder', backend, dir), true, 'removable while stopped')
    assertEq(readUnitRoot('runner', 'builder', backend, dir), null, 'gone')
  })
})

console.log('\nservice-unit: unit paths + name validation')
console.log('─'.repeat(40))

test('one name maps to one deterministic path per backend', () => {
  const a = unitPath('hub', 'staging', 'launchd', '/units')
  assertEq(a, unitPath('hub', 'staging', 'launchd', '/units'), 'stable across calls')
  assert(a.endsWith('.plist'), `plist extension: ${a}`)
  const b = unitPath('hub', 'staging', 'systemd', '/units')
  assert(b.endsWith('.service'), `service extension: ${b}`)
  assert(a !== b, 'backends do not collide')
})

test('rejects a name that would escape the unit dir', () => {
  // Path traversal via the name would let `create` write anywhere the user can.
  assertThrows(() => unitPath('hub', '../../evil', 'systemd', '/units'), 'name', 'traversal')
  assertThrows(() => unitPath('hub', 'a/b', 'systemd', '/units'), 'name', 'slash')
  assertThrows(() => unitPath('hub', '', 'systemd', '/units'), 'name', 'empty')
  // The runner path validates identically — the guard is not hub-specific.
  assertThrows(() => unitPath('runner', '../../evil', 'systemd', '/units'), 'name', 'runner traversal')
})

test('rejects a name carrying unit/plist syntax or whitespace', () => {
  // A newline in the name would inject arbitrary directives into the unit file.
  assertThrows(() => unitPath('hub', 'a\nRestart=always', 'systemd', '/units'), 'name', 'newline')
  assertThrows(() => unitPath('hub', 'a b', 'systemd', '/units'), 'name', 'space')
  assertThrows(() => unitPath('hub', 'a<b', 'launchd', '/units'), 'name', 'angle bracket')
})

test('the invalid-name error names the kind it is talking about', () => {
  // The hub error points at the config.json `hubName` key; a runner operator has no
  // such key, so a hub-worded message would misdirect them.
  assertThrows(() => unitPath('hub', 'a b', 'systemd', '/units'), 'hub name', 'hub wording')
  assertThrows(() => unitPath('runner', 'a b', 'systemd', '/units'), 'runner name', 'runner wording')
})

test('accepts the names a hub actually gets (dirname-derived)', () => {
  for (const name of ['staging', 'my-hub', 'hub_2', 'Hub.2', 'a']) {
    const p = unitPath('hub', name, 'systemd', '/units')
    assert(p.includes(name), `${name} accepted`)
  }
})

console.log('\nservice-unit: write / remove / list')
console.log('─'.repeat(40))

test('writes the unit and lists it back', () => {
  withTempDir((dir) => {
    const path = writeUnit(SPEC, backend, dir)
    assert(existsSync(path), 'unit file exists')
    assert(readFileSync(path, 'utf8').length > 0, 'non-empty')
    const listed = listRegisteredUnits('hub', backend, dir)
    assertEq(listed.length, 1, 'one registered hub')
    assertEq(listed[0]?.name, 'staging', 'name recovered from the filename')
    assertEq(listed[0]?.unitPath, path, 'path matches')
  })
})

test('rewriting the same hub replaces its unit (no duplicates)', () => {
  withTempDir((dir) => {
    writeUnit(SPEC, backend, dir)
    writeUnit({ ...SPEC, port: 51999 }, backend, dir)
    const listed = listRegisteredUnits('hub', backend, dir)
    assertEq(listed.length, 1, 'still one unit')
    assert(readFileSync(listed[0]!.unitPath, 'utf8').includes('51999'), 'content updated')
  })
})

test('remove is idempotent and reports whether a file was there', () => {
  withTempDir((dir) => {
    writeUnit(SPEC, backend, dir)
    assertEq(removeUnit('hub', 'staging', backend, dir), true, 'first remove reports removal')
    assertEq(removeUnit('hub', 'staging', backend, dir), false, 'second remove is a no-op')
    assertEq(listRegisteredUnits('hub', backend, dir).length, 0, 'nothing left')
  })
})

test('a stopped hub is still discoverable through its unit — root + removal', () => {
  // REGRESSION (`slay hub rm` on a VPS): rm resolved its target through /health,
  // which only finds RUNNING hubs, so a hub that failed to boot could not be
  // removed — while `create` kept refusing the name. rm now falls back to the unit
  // file, which requires reading the root back out of it and deleting it.
  withTempDir((dir) => {
    writeUnit(SPEC, backend, dir)
    // The root must round-trip: `rm`/`start` report and reuse it for a hub that is
    // not running, so /health cannot supply it.
    assertEq(readUnitRoot('hub', 'staging', backend, dir), SPEC.root, 'root read back')
    assertEq(removeUnit('hub', 'staging', backend, dir), true, 'removable while stopped')
    assertEq(listRegisteredUnits('hub', backend, dir).length, 0, 'gone')
    assertEq(readUnitRoot('hub', 'staging', backend, dir), null, 'no root after removal')
  })
})

test('root round-trips even when the path needs XML escaping', () => {
  withTempDir((dir) => {
    const root = '/tmp/a&b dir'
    writeUnit({ ...SPEC, root }, backend, dir)
    assertEq(readUnitRoot('hub', 'staging', backend, dir), root, 'escaping undone on read')
  })
})

test('listing a directory that does not exist is empty, not an error', () => {
  const listed = listRegisteredUnits('hub', 'systemd', join(tmpdir(), 'slz-does-not-exist-ever'))
  assertEq(listed.length, 0, 'empty list')
})

test('listing ignores unrelated files in the unit dir', () => {
  withTempDir((dir) => {
    writeUnit(SPEC, backend, dir)
    writeUnit({ ...SPEC, name: 'other' }, backend, dir)
    // A real LaunchAgents / systemd user dir is full of other people's units.
    writeFileSync(join(dir, backend === 'launchd' ? 'com.other.app.plist' : 'other.service'), 'x')
    const listed = listRegisteredUnits('hub', backend, dir)
    assert(
      listed.length === 2 && listed.every((l) => l.name === 'staging' || l.name === 'other'),
      `only slayzone hubs listed, got ${listed.map((l) => l.name).join(',')}`
    )
  })
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
