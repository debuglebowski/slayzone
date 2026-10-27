/**
 * `slay update` tests. Pure Node, no native deps.
 *
 * npm/pnpm/bun are all faked via a PATH override (tiny bash scripts) rather than
 * module-mocked: a PATH override exercises the real `execFileSync` subprocess call
 * end to end without ever touching this machine's real global installs or the real
 * registry.
 *
 * Each scenario is a describe: its beforeAll arranges the fakes and runs `slay
 * update` once, its tests read the captured result, and its afterAll undoes any
 * scenario-specific env so the next scenario starts from the shared baseline.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureAllAsync } from '../../test/test-harness'
import { updateCommand } from './update'

// $FAKE_* are bash env vars read at SCRIPT runtime, not JS template
// interpolation — only `${1:-}`-style refs need escaping below since those use
// JS's `${}` syntax too.
const FAKE_NPM = `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  root)
    [ "\${FAKE_NPM_ROOT_FAIL:-0}" = "1" ] && exit 1
    echo "$FAKE_NPM_GLOBAL_ROOT"
    ;;
  view)
    [ "\${FAKE_NPM_VIEW_FAIL:-0}" = "1" ] && exit 1
    echo "$FAKE_NPM_DIST_TAGS_JSON"
    ;;
  install)
    shift
    printf '%s\\n' "$*" >> "$FAKE_NPM_INSTALL_LOG"
    [ "\${FAKE_NPM_INSTALL_FAIL:-0}" = "1" ] && exit 1
    ;;
  *)
    exit 1
    ;;
esac
`

const FAKE_PNPM = `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  root)
    [ "\${FAKE_PNPM_ROOT_FAIL:-0}" = "1" ] && exit 1
    echo "$FAKE_PNPM_GLOBAL_ROOT"
    ;;
  view)
    [ "\${FAKE_PNPM_VIEW_FAIL:-0}" = "1" ] && exit 1
    echo "$FAKE_PNPM_DIST_TAGS_JSON"
    ;;
  add)
    shift
    printf '%s\\n' "$*" >> "$FAKE_PNPM_INSTALL_LOG"
    [ "\${FAKE_PNPM_INSTALL_FAIL:-0}" = "1" ] && exit 1
    ;;
  *)
    exit 1
    ;;
esac
`

const FAKE_BUN = `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  add)
    shift
    printf '%s\\n' "$*" >> "$FAKE_BUN_INSTALL_LOG"
    [ "\${FAKE_BUN_INSTALL_FAIL:-0}" = "1" ] && exit 1
    ;;
  *)
    exit 1
    ;;
esac
`

let npmRoot: string
let pnpmRoot: string
let bunGlobalNodeModules: string
let npmInstallLog: string
let pnpmInstallLog: string
let bunInstallLog: string

function seed(root: string, pkg: string, version: string): void {
  const dir = join(root, ...pkg.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version }))
}

function resetNpm(): void {
  rmSync(npmRoot, { recursive: true, force: true })
  mkdirSync(npmRoot, { recursive: true })
  delete process.env.FAKE_NPM_ROOT_FAIL
  delete process.env.FAKE_NPM_VIEW_FAIL
}

// pnpm/bun default to UNAVAILABLE so the pre-existing npm-only scenarios stay
// single-manager; dedicated tests opt them back in.
function disablePnpm(): void {
  process.env.FAKE_PNPM_ROOT_FAIL = '1'
}
function enablePnpm(): void {
  delete process.env.FAKE_PNPM_ROOT_FAIL
  rmSync(pnpmRoot, { recursive: true, force: true })
  mkdirSync(pnpmRoot, { recursive: true })
}
function disableBun(): void {
  rmSync(bunGlobalNodeModules, { recursive: true, force: true })
}
function enableBun(): void {
  rmSync(bunGlobalNodeModules, { recursive: true, force: true })
  mkdirSync(bunGlobalNodeModules, { recursive: true })
}

function clearInstallLogs(): void {
  rmSync(npmInstallLog, { force: true })
  rmSync(pnpmInstallLog, { force: true })
  rmSync(bunInstallLog, { force: true })
}

function readLog(path: string): string[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
}

function setDistTags(tags: Record<string, string>, via: 'npm' | 'pnpm' = 'npm'): void {
  const json = JSON.stringify(tags)
  if (via === 'npm') process.env.FAKE_NPM_DIST_TAGS_JSON = json
  else process.env.FAKE_PNPM_DIST_TAGS_JSON = json
}

async function runUpdate(
  args: string[] = []
): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | null }> {
  const cmd = updateCommand()
  return captureAllAsync(async () => {
    await cmd.parseAsync(args, { from: 'user' })
  })
}

type UpdateOut = Awaited<ReturnType<typeof runUpdate>>

let workDir: string
const origPath = process.env.PATH
const origForceNoService = process.env.SLZ_FORCE_NO_SERVICE
const origBunInstall = process.env.BUN_INSTALL

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'slz-update-test-'))
  const binDir = join(workDir, 'bin')
  mkdirSync(binDir, { recursive: true })
  for (const [name, script] of [
    ['npm', FAKE_NPM],
    ['pnpm', FAKE_PNPM],
    ['bun', FAKE_BUN]
  ] as const) {
    const p = join(binDir, name)
    writeFileSync(p, script)
    chmodSync(p, 0o755)
  }

  npmRoot = join(workDir, 'npm-root')
  pnpmRoot = join(workDir, 'pnpm-root')
  const bunInstallDir = join(workDir, 'bun-install')
  bunGlobalNodeModules = join(bunInstallDir, 'install', 'global', 'node_modules')
  npmInstallLog = join(workDir, 'npm-install.log')
  pnpmInstallLog = join(workDir, 'pnpm-install.log')
  bunInstallLog = join(workDir, 'bun-install.log')

  process.env.PATH = `${binDir}:${origPath ?? ''}`
  // Deterministic + never touches this machine's real launchd/systemd units —
  // the restart-hint path (`printRestartHints`) is exercised for its "backend
  // none => no hints" short-circuit only; listRegisteredUnits itself is already
  // covered by hub-lifecycle.test.ts / computer-lifecycle.test.ts.
  process.env.SLZ_FORCE_NO_SERVICE = '1'
  process.env.BUN_INSTALL = bunInstallDir
  process.env.FAKE_NPM_GLOBAL_ROOT = npmRoot
  process.env.FAKE_PNPM_GLOBAL_ROOT = pnpmRoot
  process.env.FAKE_NPM_INSTALL_LOG = npmInstallLog
  process.env.FAKE_PNPM_INSTALL_LOG = pnpmInstallLog
  process.env.FAKE_BUN_INSTALL_LOG = bunInstallLog
})

afterAll(() => {
  if (origPath === undefined) delete process.env.PATH
  else process.env.PATH = origPath
  if (origForceNoService === undefined) delete process.env.SLZ_FORCE_NO_SERVICE
  else process.env.SLZ_FORCE_NO_SERVICE = origForceNoService
  if (origBunInstall === undefined) delete process.env.BUN_INSTALL
  else process.env.BUN_INSTALL = origBunInstall
  for (const k of [
    'FAKE_NPM_GLOBAL_ROOT',
    'FAKE_PNPM_GLOBAL_ROOT',
    'FAKE_NPM_DIST_TAGS_JSON',
    'FAKE_PNPM_DIST_TAGS_JSON',
    'FAKE_NPM_INSTALL_LOG',
    'FAKE_PNPM_INSTALL_LOG',
    'FAKE_BUN_INSTALL_LOG',
    'FAKE_NPM_ROOT_FAIL',
    'FAKE_NPM_VIEW_FAIL',
    'FAKE_PNPM_ROOT_FAIL'
  ]) {
    delete process.env[k]
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

/** A line of `lines` containing every one of `parts` (the report prints one row per package). */
const lineWith = (lines: string[], ...parts: string[]): string | undefined =>
  lines.find((l) => parts.every((p) => l.includes(p)))

// --- nothing installed globally (npm only, empty) -------------------------
describe('nothing installed globally (npm only, empty)', () => {
  let out: UpdateOut
  beforeAll(async () => {
    resetNpm()
    disablePnpm()
    disableBun()
    clearInstallLogs()
    setDistTags({ latest: '1.0.0' })
    out = await runUpdate()
  })
  test('no packages found: reports nothing to update', () => {
    expect(lineWith(out.stdout, 'No @slayzone packages found'), out.stdout.join('\n')).toBeDefined()
  })
  test('no packages found: exits cleanly', () => {
    expect([null, 0]).toContain(out.exitCode)
  })
  test('no packages found: does not call any install', () => {
    expect(readLog(npmInstallLog)).toEqual([])
    expect(readLog(pnpmInstallLog)).toEqual([])
  })
})

// --- everything already up to date (npm) ----------------------------------
describe('everything already up to date (npm)', () => {
  let out: UpdateOut
  beforeAll(async () => {
    resetNpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/cli', '1.0.0')
    seed(npmRoot, '@slayzone/hub', '1.0.0')
    setDistTags({ latest: '1.0.0', beta: '1.1.0-beta.1' })
    out = await runUpdate()
  })
  test('up to date: reports up to date', () => {
    expect(lineWith(out.stdout, 'Everything is up to date'), out.stdout.join('\n')).toBeDefined()
  })
  test('up to date: does not call npm install', () => {
    expect(readLog(npmInstallLog)).toEqual([])
  })
})

// --- mixed outdated, stable channel (npm) ----------------------------------
describe('mixed outdated, stable channel (npm)', () => {
  let out: UpdateOut
  let log: string[]
  beforeAll(async () => {
    resetNpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/cli', '1.0.0')
    seed(npmRoot, '@slayzone/hub', '0.9.0')
    setDistTags({ latest: '1.0.0', beta: '1.1.0-beta.1' })
    out = await runUpdate()
    log = readLog(npmInstallLog)
  })
  test('mixed outdated: issues exactly one batched npm install -g call', () => {
    expect(log).toHaveLength(1)
  })
  test('mixed outdated: targets latest (no prerelease in use)', () => {
    expect(log[0]).toContain('@slayzone/hub@1.0.0')
  })
  test('mixed outdated: does not touch the already-current cli', () => {
    expect(log[0] ?? '').not.toContain('@slayzone/cli')
  })
  test('mixed outdated: prints the version bump', () => {
    expect(lineWith(out.stdout, '0.9.0', '1.0.0'), out.stdout.join('\n')).toBeDefined()
  })
})

// --- a prerelease in use routes to the beta dist-tag (npm) ------------------
describe('a prerelease in use routes to the beta dist-tag (npm)', () => {
  let log: string[]
  beforeAll(async () => {
    resetNpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/cli', '1.1.0-beta.1')
    seed(npmRoot, '@slayzone/computer', '1.0.0')
    setDistTags({ latest: '1.0.0', beta: '1.2.0-beta.3' })
    await runUpdate()
    log = readLog(npmInstallLog)
  })
  test('prerelease in use: targets beta for every outdated package', () => {
    expect(lineWith(log, '@slayzone/cli@1.2.0-beta.3'), log.join('|')).toBeDefined()
    expect(lineWith(log, '@slayzone/computer@1.2.0-beta.3'), log.join('|')).toBeDefined()
  })
})

// --- --check reports without installing (npm) --------------------------------
describe('--check reports without installing (npm)', () => {
  let out: UpdateOut
  beforeAll(async () => {
    resetNpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/hub', '0.9.0')
    setDistTags({ latest: '1.0.0' })
    out = await runUpdate(['--check'])
  })
  test('--check: reports the pending bump', () => {
    expect(lineWith(out.stdout, '0.9.0', '1.0.0'), out.stdout.join('\n')).toBeDefined()
  })
  test('--check: does not call npm install', () => {
    expect(readLog(npmInstallLog)).toEqual([])
  })
  test('--check: says nothing was installed', () => {
    expect(lineWith(out.stdout, 'nothing installed'), out.stdout.join('\n')).toBeDefined()
  })
})

// --- registry unreachable via npm falls back to pnpm's view ------------------
describe("registry unreachable via npm falls back to pnpm's view", () => {
  let out: UpdateOut
  beforeAll(async () => {
    resetNpm()
    enablePnpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/hub', '0.9.0')
    process.env.FAKE_NPM_VIEW_FAIL = '1'
    setDistTags({ latest: '1.2.0' }, 'pnpm')
    out = await runUpdate()
  })
  afterAll(() => {
    delete process.env.FAKE_NPM_VIEW_FAIL
    delete process.env.FAKE_PNPM_DIST_TAGS_JSON
    disablePnpm()
  })
  test('npm view down: falls back to pnpm view for dist-tags', () => {
    expect(lineWith(out.stdout, '0.9.0', '1.2.0'), out.stdout.join('\n')).toBeDefined()
  })
})

// --- registry unreachable everywhere => clean failure -------------------------
describe('registry unreachable everywhere => clean failure', () => {
  let out: UpdateOut
  beforeAll(async () => {
    resetNpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/hub', '0.9.0')
    delete process.env.FAKE_NPM_DIST_TAGS_JSON // fake npm echoes an empty line => JSON.parse throws
    out = await runUpdate()
  })
  afterAll(() => {
    setDistTags({ latest: '1.0.0' })
  })
  test('registry unreachable: exits non-zero', () => {
    expect(out.exitCode).toBe(1)
  })
  test('registry unreachable: explains why', () => {
    expect(
      out.stderr.some((l) => l.toLowerCase().includes('registry')),
      out.stderr.join('\n')
    ).toBe(true)
  })
})

// --- pnpm-only: detects, targets --allow-build for native pkgs only ----------
describe('pnpm-only: detects, targets --allow-build for native pkgs only', () => {
  let out: UpdateOut
  let log: string[]
  beforeAll(async () => {
    resetNpm()
    enablePnpm()
    disableBun()
    clearInstallLogs()
    seed(pnpmRoot, '@slayzone/cli', '1.0.0') // no native deps
    seed(pnpmRoot, '@slayzone/hub', '0.9.0') // native deps
    setDistTags({ latest: '1.1.0' })
    out = await runUpdate()
    log = readLog(pnpmInstallLog)
  })
  afterAll(() => {
    disablePnpm()
  })
  test('pnpm-only: reports via the pnpm manager column', () => {
    expect(lineWith(out.stdout, 'pnpm'), out.stdout.join('\n')).toBeDefined()
  })
  test('pnpm-only: --allow-build is set for hub (native deps)', () => {
    expect(lineWith(log, '--allow-build=@slayzone/hub'), log.join('|')).toBeDefined()
  })
  test('pnpm-only: --allow-build is NOT set for cli (no native deps)', () => {
    expect(lineWith(log, '--allow-build=@slayzone/cli'), log.join('|')).toBeUndefined()
  })
  test('pnpm-only: installs both outdated packages at the target version', () => {
    expect(lineWith(log, '@slayzone/cli@1.1.0'), log.join('|')).toBeDefined()
    expect(lineWith(log, '@slayzone/hub@1.1.0'), log.join('|')).toBeDefined()
  })
  test('pnpm-only: never touches npm install', () => {
    expect(readLog(npmInstallLog)).toEqual([])
  })
})

// --- bun-only: detects, sets --trust for native pkgs only --------------------
describe('bun-only: detects, sets --trust for native pkgs only', () => {
  let out: UpdateOut
  let log: string[]
  beforeAll(async () => {
    resetNpm()
    enableBun()
    clearInstallLogs()
    seed(bunGlobalNodeModules, '@slayzone/computer', '0.9.0') // native deps
    setDistTags({ latest: '1.0.0' })
    out = await runUpdate()
    log = readLog(bunInstallLog)
  })
  test('bun-only: reports via the bun manager column', () => {
    expect(lineWith(out.stdout, 'bun'), out.stdout.join('\n')).toBeDefined()
  })
  test('bun-only: --trust is set for computer (native deps)', () => {
    expect(lineWith(log, '--trust'), log.join('|')).toBeDefined()
  })
  test('bun-only: installs the outdated package at the target version', () => {
    expect(lineWith(log, '@slayzone/computer@1.0.0'), log.join('|')).toBeDefined()
  })
})

// --- bun-only, cli (no native deps): no --trust flag --------------------------
describe('bun-only, cli (no native deps): no --trust flag', () => {
  let log: string[]
  beforeAll(async () => {
    resetNpm()
    enableBun() // fresh bun root — the previous case's computer must not leak in here
    clearInstallLogs()
    seed(bunGlobalNodeModules, '@slayzone/cli', '0.9.0')
    setDistTags({ latest: '1.0.0' })
    await runUpdate()
    log = readLog(bunInstallLog)
  })
  afterAll(() => {
    disableBun()
  })
  test('bun-only, cli: no --trust flag (no native deps)', () => {
    expect(lineWith(log, '--trust'), log.join('|')).toBeUndefined()
  })
})

// --- same package found via two managers at once: tracked independently -----
describe('same package found via two managers at once: tracked independently', () => {
  let out: UpdateOut
  beforeAll(async () => {
    resetNpm()
    enablePnpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/hub', '0.9.0') // outdated
    seed(pnpmRoot, '@slayzone/hub', '1.0.0') // already current
    setDistTags({ latest: '1.0.0' })
    out = await runUpdate()
  })
  afterAll(() => {
    disablePnpm()
  })
  test('dual-manager: both rows show up in the report', () => {
    expect(
      out.stdout.filter((l) => l.includes('@slayzone/hub')).length,
      out.stdout.join('\n')
    ).toBeGreaterThanOrEqual(2)
  })
  test('dual-manager: only the outdated (npm) copy gets installed', () => {
    expect(lineWith(readLog(npmInstallLog), '@slayzone/hub@1.0.0')).toBeDefined()
    expect(readLog(pnpmInstallLog)).toEqual([])
  })
})

// --- no manager available at all => clean failure ------------------------------
describe('no manager available at all => clean failure', () => {
  let out: UpdateOut
  beforeAll(async () => {
    resetNpm()
    disablePnpm()
    disableBun()
    process.env.FAKE_NPM_ROOT_FAIL = '1'
    out = await runUpdate()
  })
  afterAll(() => {
    delete process.env.FAKE_NPM_ROOT_FAIL
  })
  test('no manager available: exits non-zero', () => {
    expect(out.exitCode).toBe(1)
  })
  test('no manager available: names all three', () => {
    expect(lineWith(out.stderr, 'npm', 'pnpm', 'bun'), out.stderr.join('\n')).toBeDefined()
  })
})
