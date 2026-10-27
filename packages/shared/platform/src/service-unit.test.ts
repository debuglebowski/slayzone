/**
 * OS-supervisor registration for hubs AND computers (plans/hub-lifecycle-and-discovery.md
 * Phase 5 for the hub; the `slay computer` group for the computer).
 *
 * `slay hub create` / `slay computer create` hand the process to launchd (macOS) or
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
 *   - the two KINDS never see each other's units, and a computer unit carries NO
 *     hub env (its name/token/path-jail have no env channel — see computer/src/config.ts).
 *
 * Pure Node (temp dirs, no native deps, no supervisor calls) → runs under plain
 * `npx tsx`.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts packages/shared/platform/src/service-unit.test.ts
 */
import { describe, expect, test } from 'vitest'
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectBackend,
  explainNoBackend,
  launchdLabel,
  listRegisteredUnits,
  readUnitEnv,
  readUnitRoot,
  readUnitSecrets,
  removeUnit,
  renderLaunchdPlist,
  renderSystemdUnit,
  systemdUnitName,
  unitPath,
  userServiceEnv,
  writeUnit,
  type ServiceUnitSpec
} from './service-unit'

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

const COMPUTER_SPEC: ServiceUnitSpec = {
  kind: 'computer',
  name: 'builder',
  root: '/srv/computers/builder',
  command: '/usr/local/bin/node',
  args: ['/opt/computer/dist/bin.cjs'],
  logDir: '/srv/computers/builder/logs'
}

describe('service-unit: backend detection', () => {
  test('detects a backend appropriate to the platform', () => {
    const detected = detectBackend()
    if (process.platform === 'darwin') expect(detected, 'macOS → launchd').toBe('launchd')
    else if (process.platform === 'win32')
      expect(detected, 'Windows → no user supervisor yet').toBe('none')
    else
      expect(['systemd', 'none'], 'linux → systemd or none').toContain(detected)
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
    expect(decide('', true), 'no bus ⇒ not usable').toBe('none')
    // Healthy.
    expect(decide('running\n', false), 'running ⇒ usable').toBe('systemd')
    // Non-zero exit but a real state: some unrelated unit failed. Still usable —
    // treating this as `none` would needlessly downgrade a working box.
    expect(decide('degraded\n', true), 'degraded ⇒ still usable').toBe('systemd')
    expect(decide('offline\n', true), 'offline ⇒ not usable').toBe('none')
  })

  test('userServiceEnv derives XDG_RUNTIME_DIR only when it is the missing piece', () => {
    // REGRESSION (cost an hour on a real VPS): a shell attached to an existing zellij
    // session inherits no XDG_RUNTIME_DIR, so every `systemctl --user` call failed with
    // "No medium found" and detection reported "this platform has no user service
    // manager" — on a box where systemd, the user manager and /run/user/999 were all
    // present and healthy. The address is derivable from the uid, so we supply it
    // rather than making an operator export a value we can compute.
    const original = process.env.XDG_RUNTIME_DIR
    const uid = process.getuid?.()
    try {
      // Already set ⇒ untouched. The operator's own value always wins; a session bus
      // deliberately pointed elsewhere must not be silently overridden.
      process.env.XDG_RUNTIME_DIR = '/run/user/explicit'
      expect(userServiceEnv().XDG_RUNTIME_DIR, 'an explicit value is never overridden').toBe('/run/user/explicit')

      delete process.env.XDG_RUNTIME_DIR
      const healed = userServiceEnv().XDG_RUNTIME_DIR
      if (uid !== undefined && existsSync(`/run/user/${uid}`)) {
        expect(healed, 'unset + dir exists ⇒ derived from uid').toBe(`/run/user/${uid}`)
      } else {
        // No runtime dir on this host (macOS, or a container without one): there is
        // nothing to derive, and inventing a path would make detection claim a bus
        // that cannot answer. Staying unset is what lets `none` stay honest.
        expect(healed, 'unset + no dir ⇒ left unset, not invented').toBe(undefined)
      }
    } finally {
      if (original === undefined) delete process.env.XDG_RUNTIME_DIR
      else process.env.XDG_RUNTIME_DIR = original
    }
  })

  test('a none backend explains the actual fix, not just the absence', () => {
    // The old message ("this platform has no user service manager") was true but
    // unactionable, and identical for two very different machines. Each reason must
    // name the fix that applies to IT.
    expect(explainNoBackend('systemd-no-bus'), 'no user manager ⇒ points at loginctl enable-linger').toMatch(/enable-linger/)
    expect(explainNoBackend('systemd-missing'), 'no systemd at all ⇒ lingering is not the fix and must not be suggested').not.toMatch(/enable-linger/)
    expect(explainNoBackend('windows'), 'windows names the platform').toMatch(/Windows/)
  })
})

describe('service-unit: launchd plist content (hub)', () => {
  test('plist carries label, absolute command, cwd, env and log paths', () => {
    const xml = renderLaunchdPlist(SPEC)
    expect(xml, 'has a Label').toContain('<key>Label</key>')
    expect(xml, 'label namespaced by hub name').toContain('com.slayzone.hub.staging')
    expect(xml, 'absolute program path').toContain('/usr/local/bin/node')
    expect(xml, 'program argument').toContain('/opt/hub/dist/bin.cjs')
    expect(xml, 'sets a working directory').toContain('<key>WorkingDirectory</key>')
    expect(xml, 'cwd = hub root').toContain('/Users/x/hubs/staging')
    // The unit must PIN the root: launchd gives an agent a near-empty environment,
    // so relying on the inherited cwd default would anchor the hub elsewhere.
    expect(xml, 'pins SLAYZONE_ROOT explicitly').toContain('SLAYZONE_ROOT')
    expect(xml, 'log paths under the hub root').toContain('/Users/x/hubs/staging/storage/logs')
  })

  test('plist restarts on crash but NOT after a clean stop', () => {
    const xml = renderLaunchdPlist(SPEC)
    // KeepAlive/SuccessfulExit=false ⇒ relaunch only on non-zero exit. A bare
    // `KeepAlive: true` would fight `slay hub stop` forever.
    expect(xml, 'has KeepAlive').toContain('<key>KeepAlive</key>')
    expect(xml, 'conditions KeepAlive on exit status').toContain('<key>SuccessfulExit</key>')
    const afterSuccessfulExit = xml.slice(xml.indexOf('<key>SuccessfulExit</key>'))
    expect(afterSuccessfulExit.trimStart().startsWith('<key>SuccessfulExit</key>'), 'sanity').toBe(true)
    expect(afterSuccessfulExit.indexOf('<false/>') < afterSuccessfulExit.indexOf('<key>', 25) ||
        afterSuccessfulExit.includes('<false/>'), 'SuccessfulExit is false (do not relaunch after a clean exit)').toBeTruthy()
    expect(xml, 'starts at load/login').toContain('<key>RunAtLoad</key>')
  })

  test('plist is well-formed XML with the plist preamble', () => {
    const xml = renderLaunchdPlist(SPEC)
    expect(xml.startsWith('<?xml'), 'xml declaration first').toBe(true)
    expect(xml, 'doctype').toContain('<!DOCTYPE plist')
    expect(xml.trimEnd().endsWith('</plist>'), 'closes the plist').toBe(true)
    const opens = (xml.match(/<dict>/g) ?? []).length
    const closes = (xml.match(/<\/dict>/g) ?? []).length
    expect(opens, 'balanced <dict> tags').toBe(closes)
  })

  test('plist escapes XML metacharacters in paths', () => {
    const xml = renderLaunchdPlist({ ...SPEC, root: '/tmp/a&b<c>', logDir: '/tmp/a&b<c>/logs' })
    expect(xml, 'ampersand escaped').toContain('&amp;')
    expect(xml, 'raw ampersand gone').not.toContain('a&b')
    expect(xml, 'angle brackets escaped').toContain('&lt;c&gt;')
  })
})

describe('service-unit: systemd unit content (hub)', () => {
  test('unit carries ExecStart, WorkingDirectory, Environment and install target', () => {
    const unit = renderSystemdUnit(SPEC)
    expect(unit, 'has [Unit]').toContain('[Unit]')
    expect(unit, 'has [Service]').toContain('[Service]')
    expect(unit, 'has [Install] — else `enable` is a no-op').toContain('[Install]')
    expect(unit, 'absolute ExecStart with args').toContain('ExecStart=/usr/local/bin/node /opt/hub/dist/bin.cjs')
    expect(unit, 'cwd = hub root').toContain('WorkingDirectory=/Users/x/hubs/staging')
    expect(unit, 'pins SLAYZONE_ROOT').toContain('Environment=SLAYZONE_ROOT=/Users/x/hubs/staging')
    expect(unit, 'enabled for the user session').toContain('WantedBy=default.target')
  })

  test('unit restarts on failure only, and identifies the hub', () => {
    const unit = renderSystemdUnit(SPEC)
    expect(unit, 'on-failure, not always (a clean stop must stick)').toContain('Restart=on-failure')
    expect(unit, 'has a restart backoff').toContain('RestartSec=')
    expect(unit, 'description names the hub').toMatch(/Description=.*staging/)
  })

  test('unit sets the hub name env so /health reports the same label', () => {
    const unit = renderSystemdUnit(SPEC)
    expect(unit, 'pins the name').toContain('Environment=SLAYZONE_HUB_NAME=staging')
  })

  test('an explicit port reaches the unit as SLAYZONE_HUB_LISTEN_ADDRESS', () => {
    const unit = renderSystemdUnit({ ...SPEC, port: 51234 })
    expect(unit, 'port present').toContain('51234')
    expect(unit, 'passed via the address var, not a bare port').toContain('SLAYZONE_HUB_LISTEN_ADDRESS')
    const plist = renderLaunchdPlist({ ...SPEC, port: 51234 })
    expect(plist, 'same in the plist').toContain('51234')
    expect(plist, 'same in the plist').toContain('SLAYZONE_HUB_LISTEN_ADDRESS')
  })

  test('a hub unit NEVER carries the dial-side SLAYZONE_HUB_ADDRESS (a hub refuses to boot with it)', () => {
    for (const spec of [SPEC, { ...SPEC, port: 51234 }, { ...SPEC, address: '0.0.0.0:51234' }]) {
      const unit = renderSystemdUnit(spec)
      expect(unit, `systemd: ${unit}`).not.toMatch(/SLAYZONE_HUB_ADDRESS\b/)
      const plist = renderLaunchdPlist(spec)
      expect(plist, 'plist').not.toMatch(/SLAYZONE_HUB_ADDRESS\b/)
    }
  })

  test('no port ⇒ no address var (hub picks a free block port itself)', () => {
    const unit = renderSystemdUnit(SPEC)
    expect(unit, 'absent when unspecified').not.toContain('SLAYZONE_HUB_LISTEN_ADDRESS')
  })

  // `address` carries a full authority so a REMOTE hub can bind wider than loopback.
  // `port` cannot express that — it hardcodes `127.0.0.1:<port>` — but it stays as the
  // deprecated alias, because every existing caller passes it and the two specs above
  // pin its exact output.
  test('an explicit address reaches the unit verbatim (a remote hub binds wider)', () => {
    const unit = renderSystemdUnit({ ...SPEC, address: '0.0.0.0:51234' })
    expect(unit, `wildcard bind preserved: ${unit}`).toContain('Environment=SLAYZONE_HUB_LISTEN_ADDRESS=0.0.0.0:51234')
    const plist = renderLaunchdPlist({ ...SPEC, address: '0.0.0.0:51234' })
    expect(plist, 'same in the plist').toContain('0.0.0.0:51234')
  })

  test('address WINS over the legacy port (no silent loopback downgrade)', () => {
    // Both given is the shape `hub create --port X --public-address Y` produces. If
    // `port` won, a remote hub would bind loopback and be unreachable — the exact bug
    // the address field exists to prevent.
    const unit = renderSystemdUnit({ ...SPEC, port: 51234, address: '0.0.0.0:51234' })
    expect(unit, `address used: ${unit}`).toContain('SLAYZONE_HUB_LISTEN_ADDRESS=0.0.0.0:51234')
    expect(unit, 'no loopback address emitted').not.toContain('127.0.0.1')
  })

  test('a computer spec ignores address too (a computer binds nothing)', () => {
    const unit = renderSystemdUnit({ ...COMPUTER_SPEC, address: '0.0.0.0:51234' })
    expect(unit, 'no address var for a computer').not.toContain('SLAYZONE_HUB_LISTEN_ADDRESS')
    expect(unit, 'address not emitted').not.toContain('0.0.0.0')
  })

  test('spec.env reaches the unit — an Electron-ABI hub needs ELECTRON_RUN_AS_NODE', () => {
    // A dev-tree hub's better-sqlite3 is compiled for Electron's ABI, so it must run
    // as `ELECTRON_RUN_AS_NODE=1 <electron>`; without this the supervisor crash-loops
    // it invisibly on `NODE_MODULE_VERSION` mismatch.
    const withEnv = { ...SPEC, env: { ELECTRON_RUN_AS_NODE: '1' } }
    const unit = renderSystemdUnit(withEnv)
    expect(unit, `systemd: ${unit}`).toContain('Environment=ELECTRON_RUN_AS_NODE=1')
    const plist = renderLaunchdPlist(withEnv)
    expect(plist, 'plist carries the key').toContain('ELECTRON_RUN_AS_NODE')
    expect(plist, 'plist value').toMatch(/<key>ELECTRON_RUN_AS_NODE<\/key>\s*<string>1<\/string>/)
    // The SlayZone vars must survive alongside it.
    expect(unit, 'root still pinned').toContain('SLAYZONE_ROOT=')
    expect(plist, 'name still pinned').toContain('SLAYZONE_HUB_NAME')
  })
})

describe('service-unit: computer kind', () => {
  test('computer identity is namespaced apart from the hub', () => {
    expect(launchdLabel('computer', 'builder'), 'launchd label').toBe('com.slayzone.computer.builder')
    expect(systemdUnitName('computer', 'builder'), 'systemd unit').toBe('slayzone-computer-builder.service')
    // Same NAME under the two kinds must never resolve to the same file, or
    // `computer rm dev` would delete a hub named dev.
    expect(unitPath('computer', 'dev', backend, '/units'), 'a name shared across kinds does not collide').not.toBe(unitPath('hub', 'dev', backend, '/units'))
  })

  test('computer plist/unit identify the computer and use computer log names', () => {
    const plist = renderLaunchdPlist(COMPUTER_SPEC)
    expect(plist, `label: ${plist}`).toContain('<string>com.slayzone.computer.builder</string>')
    expect(plist, 'stdout log').toContain('/srv/computers/builder/logs/computer.out.log')
    expect(plist, 'stderr log').toContain('/srv/computers/builder/logs/computer.err.log')
    expect(plist, 'no hub log name leaked').not.toContain('hub.out.log')
    const unit = renderSystemdUnit(COMPUTER_SPEC)
    expect(unit, `description: ${unit}`).toContain('Description=SlayZone computer (builder)')
    expect(unit, 'log hint names the computer command').toContain('slay computer logs builder')
  })

  test('a computer unit carries SLAYZONE_ROOT and NOTHING hub-shaped', () => {
    // The computer's name, path-jail, join token and cert pin deliberately have NO env
    // channel (computer/src/config.ts) — they come from <ROOT>/config.json, which is
    // 0600. A unit file is 0644, so a token must never reach it.
    const unit = renderSystemdUnit(COMPUTER_SPEC)
    expect(unit, 'root pinned').toContain('Environment=SLAYZONE_ROOT=/srv/computers/builder')
    expect(unit, 'no hub name var').not.toContain('SLAYZONE_HUB_NAME')
    expect(unit, 'no hub address var').not.toContain('SLAYZONE_HUB_ADDRESS')
    expect(unit, 'no hub listen address var').not.toContain('SLAYZONE_HUB_LISTEN_ADDRESS')
    expect(unit, 'never a join token in a 0644 unit').not.toContain('SLAYZONE_HUB_JOIN_TOKEN')
    const envLines = unit.split('\n').filter((l) => l.startsWith('Environment='))
    expect(envLines.length, `exactly one env line, got ${envLines.join(' | ')}`).toBe(1)
  })

  test('a computer spec ignores port (only a hub binds one)', () => {
    const unit = renderSystemdUnit({ ...COMPUTER_SPEC, port: 51234 })
    expect(unit, 'port not emitted for a computer').not.toContain('51234')
    expect(unit, 'no address var').not.toContain('SLAYZONE_HUB_ADDRESS')
    expect(unit, 'no listen address var').not.toContain('SLAYZONE_HUB_LISTEN_ADDRESS')
  })

  test('spec.env reaches a computer unit too — node-pty is Electron-ABI in a dev tree', () => {
    const unit = renderSystemdUnit({ ...COMPUTER_SPEC, env: { ELECTRON_RUN_AS_NODE: '1' } })
    expect(unit, `systemd: ${unit}`).toContain('Environment=ELECTRON_RUN_AS_NODE=1')
    expect(unit, 'root still pinned').toContain('Environment=SLAYZONE_ROOT=')
  })

  test('the two kinds never list each other, even in one unit dir', () => {
    withTempDir((dir) => {
      writeUnit(SPEC, backend, dir)
      writeUnit(COMPUTER_SPEC, backend, dir)
      const hubs = listRegisteredUnits('hub', backend, dir)
      expect(hubs.length, `one hub, got ${hubs.map((h) => h.name).join(',')}`).toBe(1)
      expect(hubs[0]?.name, 'the hub').toBe('staging')
      const computers = listRegisteredUnits('computer', backend, dir)
      expect(computers.length, `one computer, got ${computers.map((r) => r.name).join(',')}`).toBe(1)
      expect(computers[0]?.name, 'the computer').toBe('builder')
    })
  })

  test('a hub named like a computer prefix is not mistaken for a computer', () => {
    // `slayzone-hub-computer-x.service` must not parse as computer `x`: the computer listing
    // only accepts its own prefix, which the hub filename does not carry.
    withTempDir((dir) => {
      writeUnit({ ...SPEC, name: 'computer-x' }, backend, dir)
      expect(listRegisteredUnits('computer', backend, dir).length, 'no computer found').toBe(0)
      expect(listRegisteredUnits('hub', backend, dir)[0]?.name, 'listed as a hub').toBe('computer-x')
    })
  })

  test('a computer root round-trips through its unit while stopped', () => {
    withTempDir((dir) => {
      writeUnit(COMPUTER_SPEC, backend, dir)
      expect(readUnitRoot('computer', 'builder', backend, dir), 'root read back').toBe(COMPUTER_SPEC.root)
      expect(readUnitRoot('hub', 'builder', backend, dir), 'not visible as a hub').toBe(null)
      expect(removeUnit('computer', 'builder', backend, dir), 'removable while stopped').toBe(true)
      expect(readUnitRoot('computer', 'builder', backend, dir), 'gone').toBe(null)
    })
  })
})

describe('service-unit: unit paths + name validation', () => {
  test('one name maps to one deterministic path per backend', () => {
    const a = unitPath('hub', 'staging', 'launchd', '/units')
    expect(a, 'stable across calls').toBe(unitPath('hub', 'staging', 'launchd', '/units'))
    expect(a.endsWith('.plist'), `plist extension: ${a}`).toBe(true)
    const b = unitPath('hub', 'staging', 'systemd', '/units')
    expect(b.endsWith('.service'), `service extension: ${b}`).toBe(true)
    expect(a, 'backends do not collide').not.toBe(b)
  })

  test('rejects a name that would escape the unit dir', () => {
    // Path traversal via the name would let `create` write anywhere the user can.
    expect(() => unitPath('hub', '../../evil', 'systemd', '/units'), 'traversal').toThrow('name')
    expect(() => unitPath('hub', 'a/b', 'systemd', '/units'), 'slash').toThrow('name')
    expect(() => unitPath('hub', '', 'systemd', '/units'), 'empty').toThrow('name')
    // The computer path validates identically — the guard is not hub-specific.
    expect(() => unitPath('computer', '../../evil', 'systemd', '/units'), 'computer traversal').toThrow('name')
  })

  test('rejects a name carrying unit/plist syntax or whitespace', () => {
    // A newline in the name would inject arbitrary directives into the unit file.
    expect(() => unitPath('hub', 'a\nRestart=always', 'systemd', '/units'), 'newline').toThrow('name')
    expect(() => unitPath('hub', 'a b', 'systemd', '/units'), 'space').toThrow('name')
    expect(() => unitPath('hub', 'a<b', 'launchd', '/units'), 'angle bracket').toThrow('name')
  })

  test('the invalid-name error names the kind it is talking about', () => {
    // The hub error points at the config.json `hubName` key; a computer operator has no
    // such key, so a hub-worded message would misdirect them.
    expect(() => unitPath('hub', 'a b', 'systemd', '/units'), 'hub wording').toThrow('hub name')
    expect(() => unitPath('computer', 'a b', 'systemd', '/units'), 'computer wording').toThrow('computer name')
  })

  test('accepts the names a hub actually gets (dirname-derived)', () => {
    for (const name of ['staging', 'my-hub', 'hub_2', 'Hub.2', 'a']) {
      const p = unitPath('hub', name, 'systemd', '/units')
      expect(p, `${name} accepted`).toContain(name)
    }
  })
})

describe('service-unit: write / remove / list', () => {
  test('writes the unit and lists it back', () => {
    withTempDir((dir) => {
      const path = writeUnit(SPEC, backend, dir)
      expect(existsSync(path), 'unit file exists').toBe(true)
      expect(readFileSync(path, 'utf8').length, 'non-empty').toBeGreaterThan(0)
      const listed = listRegisteredUnits('hub', backend, dir)
      expect(listed.length, 'one registered hub').toBe(1)
      expect(listed[0]?.name, 'name recovered from the filename').toBe('staging')
      expect(listed[0]?.unitPath, 'path matches').toBe(path)
    })
  })

  test('rewriting the same hub replaces its unit (no duplicates)', () => {
    withTempDir((dir) => {
      writeUnit(SPEC, backend, dir)
      writeUnit({ ...SPEC, port: 51999 }, backend, dir)
      const listed = listRegisteredUnits('hub', backend, dir)
      expect(listed.length, 'still one unit').toBe(1)
      expect(readFileSync(listed[0]!.unitPath, 'utf8'), 'content updated').toContain('51999')
    })
  })

  test('remove is idempotent and reports whether a file was there', () => {
    withTempDir((dir) => {
      writeUnit(SPEC, backend, dir)
      expect(removeUnit('hub', 'staging', backend, dir), 'first remove reports removal').toBe(true)
      expect(removeUnit('hub', 'staging', backend, dir), 'second remove is a no-op').toBe(false)
      expect(listRegisteredUnits('hub', backend, dir).length, 'nothing left').toBe(0)
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
      expect(readUnitRoot('hub', 'staging', backend, dir), 'root read back').toBe(SPEC.root)
      expect(removeUnit('hub', 'staging', backend, dir), 'removable while stopped').toBe(true)
      expect(listRegisteredUnits('hub', backend, dir).length, 'gone').toBe(0)
      expect(readUnitRoot('hub', 'staging', backend, dir), 'no root after removal').toBe(null)
    })
  })

  test('root round-trips even when the path needs XML escaping', () => {
    withTempDir((dir) => {
      const root = '/tmp/a&b dir'
      writeUnit({ ...SPEC, root }, backend, dir)
      expect(readUnitRoot('hub', 'staging', backend, dir), 'escaping undone on read').toBe(root)
    })
  })

  test('listing a directory that does not exist is empty, not an error', () => {
    const listed = listRegisteredUnits('hub', 'systemd', join(tmpdir(), 'slz-does-not-exist-ever'))
    expect(listed.length, 'empty list').toBe(0)
  })

  test('listing ignores unrelated files in the unit dir', () => {
    withTempDir((dir) => {
      writeUnit(SPEC, backend, dir)
      writeUnit({ ...SPEC, name: 'other' }, backend, dir)
      // A real LaunchAgents / systemd user dir is full of other people's units.
      writeFileSync(join(dir, backend === 'launchd' ? 'com.other.app.plist' : 'other.service'), 'x')
      const listed = listRegisteredUnits('hub', backend, dir)
      expect(listed.length, `only slayzone hubs listed, got ${listed.map((l) => l.name).join(',')}`).toBe(2)
      expect(listed.every((l) => l.name === 'staging' || l.name === 'other'), `only slayzone hubs listed, got ${listed.map((l) => l.name).join(',')}`).toBeTruthy()
    })
  })
})

describe('service-unit: secrets in a unit (a hub other machines reach needs its auth secret)', () => {
  for (const be of ['launchd', 'systemd'] as const) {
    test(`${be}: a unit that pins a secret is owner-only (0600); one that does not stays 0644`, () => {
      if (process.platform === 'win32') return
      withTempDir((dir) => {
        const plain = writeUnit(SPEC, be, dir)
        expect(statSync(plain).mode & 0o777, 'no secret → 0644').toBe(0o644)
        const secret = writeUnit(
          { ...SPEC, name: 'reach', env: { SLAYZONE_HUB_AUTH_SECRET: 's3cret' } },
          be,
          dir
        )
        expect(statSync(secret).mode & 0o777, 'secret → 0600').toBe(0o600)
      })
    })

    test(`${be}: rewriting an older world-readable unit with a secret tightens it`, () => {
      if (process.platform === 'win32') return
      withTempDir((dir) => {
        const path = writeUnit(SPEC, be, dir)
        expect(statSync(path).mode & 0o777, 'starts 0644').toBe(0o644)
        writeUnit({ ...SPEC, env: { SLAYZONE_HUB_AUTH_SECRET: 's3cret' } }, be, dir)
        expect(statSync(path).mode & 0o777, 'tightened on rewrite').toBe(0o600)
      })
    })

    test(`${be}: the secret is never written into the old world-readable file`, () => {
      if (process.platform === 'win32') return
      withTempDir((dir) => {
        const path = writeUnit(SPEC, be, dir)
        // A second name for the OLD inode: if the rewrite wrote through the existing
        // 0644 file (then chmod-ed), the secret would be readable here for the moment
        // between the two and would still be in this inode afterwards.
        const oldInode = join(dir, 'old-inode.copy')
        linkSync(path, oldInode)
        writeUnit({ ...SPEC, env: { SLAYZONE_HUB_AUTH_SECRET: 'never-in-0644' } }, be, dir)
        expect(readFileSync(path, 'utf8'), 'the unit carries the secret').toContain('never-in-0644')
        expect(statSync(path).mode & 0o777, 'owner-only').toBe(0o600)
        expect(readFileSync(oldInode, 'utf8'), 'the previous (0644) inode never saw the secret').not.toContain('never-in-0644')
      })
    })

    test(`${be}: writing a secret unit leaves no temp file behind, even after a stale one`, () => {
      if (process.platform === 'win32') return
      withTempDir((dir) => {
        const path = unitPath(SPEC.kind, SPEC.name, be, dir)
        // A leftover from a crashed earlier write of the same unit (same pid is the
        // worst case: the 'wx' create must not trip over it).
        writeFileSync(`${path}.${process.pid}.tmp`, 'stale')
        writeUnit({ ...SPEC, env: { SLAYZONE_HUB_AUTH_SECRET: 's3cret' } }, be, dir)
        const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'))
        expect(leftovers.length, `no temp files left: ${leftovers.join(',')}`).toBe(0)
      })
    })

    test(`${be}: readUnitEnv reads back every pinned var, unescaped`, () => {
      withTempDir((dir) => {
        writeUnit(
          { ...SPEC, address: '0.0.0.0:51234', env: { SLAYZONE_HUB_AUTH_SECRET: 'a&b<c>"d' } },
          be,
          dir
        )
        const env = readUnitEnv('hub', 'staging', be, dir)
        expect(env.SLAYZONE_ROOT, 'root').toBe(SPEC.root)
        expect(env.SLAYZONE_HUB_NAME, 'name').toBe('staging')
        expect(env.SLAYZONE_HUB_LISTEN_ADDRESS, 'listen address').toBe('0.0.0.0:51234')
        if (be === 'launchd') expect(env.SLAYZONE_HUB_AUTH_SECRET, 'xml unescaped').toBe('a&b<c>"d')
      })
    })

    test(`${be}: readUnitSecrets returns ONLY the secret keys (what a rewrite must carry over)`, () => {
      withTempDir((dir) => {
        writeUnit(
          {
            ...SPEC,
            env: {
              SLAYZONE_HUB_AUTH_SECRET: 'abc',
              SLAYZONE_HUB_SSO_CLIENT_SECRET: 'def',
              ELECTRON_RUN_AS_NODE: '1'
            }
          },
          be,
          dir
        )
        const secrets = readUnitSecrets('hub', 'staging', be, dir)
        expect(Object.keys(secrets).sort().join(','), 'only the secrets').toBe('SLAYZONE_HUB_AUTH_SECRET,SLAYZONE_HUB_SSO_CLIENT_SECRET')
        expect(secrets.SLAYZONE_HUB_AUTH_SECRET, 'auth secret').toBe('abc')
        expect(secrets.SLAYZONE_HUB_SSO_CLIENT_SECRET, 'sso secret').toBe('def')
      })
    })

    test(`${be}: a missing unit reads as empty env, never throws`, () => {
      withTempDir((dir) => {
        expect(Object.keys(readUnitEnv('hub', 'nope', be, dir)).length, 'empty').toBe(0)
        expect(Object.keys(readUnitSecrets('hub', 'nope', be, dir)).length, 'empty secrets').toBe(0)
      })
    })
  }
})
