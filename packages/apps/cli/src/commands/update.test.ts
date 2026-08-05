/**
 * `slay update` tests. Pure Node, no native deps → runs under plain `npx tsx`.
 *
 * npm/pnpm/bun are all faked via a PATH override (tiny bash scripts) rather than
 * mocked: `update.ts` imports `execFileSync` as a live ESM binding, which plain
 * `tsx` (no vitest/jest here) cannot intercept — a PATH override exercises the
 * real subprocess call end to end without ever touching this machine's real
 * global installs or the real registry.
 */
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

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}

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

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'slz-update-test-'))
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

  const origPath = process.env.PATH
  const origForceNoService = process.env.SLZ_FORCE_NO_SERVICE
  const origBunInstall = process.env.BUN_INSTALL
  process.env.PATH = `${binDir}:${origPath ?? ''}`
  // Deterministic + never touches this machine's real launchd/systemd units —
  // the restart-hint path (`printRestartHints`) is exercised for its "backend
  // none => no hints" short-circuit only; listRegisteredUnits itself is already
  // covered by hub-lifecycle.test.ts / runner-lifecycle.test.ts.
  process.env.SLZ_FORCE_NO_SERVICE = '1'
  process.env.BUN_INSTALL = bunInstallDir
  process.env.FAKE_NPM_GLOBAL_ROOT = npmRoot
  process.env.FAKE_PNPM_GLOBAL_ROOT = pnpmRoot
  process.env.FAKE_NPM_INSTALL_LOG = npmInstallLog
  process.env.FAKE_PNPM_INSTALL_LOG = pnpmInstallLog
  process.env.FAKE_BUN_INSTALL_LOG = bunInstallLog

  try {
    // --- nothing installed globally (npm only, empty) -------------------------
    resetNpm()
    disablePnpm()
    disableBun()
    clearInstallLogs()
    setDistTags({ latest: '1.0.0' })
    {
      const { stdout, exitCode } = await runUpdate()
      check(
        'no packages found: reports nothing to update',
        stdout.some((l) => l.includes('No @slayzone packages found')),
        stdout.join('\n')
      )
      check('no packages found: exits cleanly', exitCode === null || exitCode === 0)
      check(
        'no packages found: does not call any install',
        readLog(npmInstallLog).length === 0 && readLog(pnpmInstallLog).length === 0
      )
    }

    // --- everything already up to date (npm) ----------------------------------
    resetNpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/cli', '1.0.0')
    seed(npmRoot, '@slayzone/hub', '1.0.0')
    setDistTags({ latest: '1.0.0', beta: '1.1.0-beta.1' })
    {
      const { stdout } = await runUpdate()
      check(
        'up to date: reports up to date',
        stdout.some((l) => l.includes('Everything is up to date')),
        stdout.join('\n')
      )
      check('up to date: does not call npm install', readLog(npmInstallLog).length === 0)
    }

    // --- mixed outdated, stable channel (npm) ----------------------------------
    resetNpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/cli', '1.0.0')
    seed(npmRoot, '@slayzone/hub', '0.9.0')
    setDistTags({ latest: '1.0.0', beta: '1.1.0-beta.1' })
    {
      const { stdout } = await runUpdate()
      const log = readLog(npmInstallLog)
      check('mixed outdated: issues exactly one batched npm install -g call', log.length === 1, log.join('|'))
      check(
        'mixed outdated: targets latest (no prerelease in use)',
        log[0]?.includes('@slayzone/hub@1.0.0') ?? false,
        log[0]
      )
      check(
        'mixed outdated: does not touch the already-current cli',
        !(log[0]?.includes('@slayzone/cli') ?? false),
        log[0]
      )
      check(
        'mixed outdated: prints the version bump',
        stdout.some((l) => l.includes('0.9.0') && l.includes('1.0.0')),
        stdout.join('\n')
      )
    }

    // --- a prerelease in use routes to the beta dist-tag (npm) ------------------
    resetNpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/cli', '1.1.0-beta.1')
    seed(npmRoot, '@slayzone/runner', '1.0.0')
    setDistTags({ latest: '1.0.0', beta: '1.2.0-beta.3' })
    {
      await runUpdate()
      const log = readLog(npmInstallLog)
      check(
        'prerelease in use: targets beta for every outdated package',
        log.some((l) => l.includes('@slayzone/cli@1.2.0-beta.3')) &&
          log.some((l) => l.includes('@slayzone/runner@1.2.0-beta.3')),
        log.join('|')
      )
    }

    // --- --check reports without installing (npm) --------------------------------
    resetNpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/hub', '0.9.0')
    setDistTags({ latest: '1.0.0' })
    {
      const { stdout } = await runUpdate(['--check'])
      check(
        '--check: reports the pending bump',
        stdout.some((l) => l.includes('0.9.0') && l.includes('1.0.0')),
        stdout.join('\n')
      )
      check('--check: does not call npm install', readLog(npmInstallLog).length === 0)
      check(
        '--check: says nothing was installed',
        stdout.some((l) => l.includes('nothing installed')),
        stdout.join('\n')
      )
    }

    // --- registry unreachable via npm falls back to pnpm's view ------------------
    resetNpm()
    enablePnpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/hub', '0.9.0')
    process.env.FAKE_NPM_VIEW_FAIL = '1'
    setDistTags({ latest: '1.2.0' }, 'pnpm')
    {
      const { stdout } = await runUpdate()
      check(
        'npm view down: falls back to pnpm view for dist-tags',
        stdout.some((l) => l.includes('0.9.0') && l.includes('1.2.0')),
        stdout.join('\n')
      )
    }
    delete process.env.FAKE_NPM_VIEW_FAIL
    delete process.env.FAKE_PNPM_DIST_TAGS_JSON
    disablePnpm()

    // --- registry unreachable everywhere => clean failure -------------------------
    resetNpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/hub', '0.9.0')
    delete process.env.FAKE_NPM_DIST_TAGS_JSON // fake npm echoes an empty line => JSON.parse throws
    {
      const { exitCode, stderr } = await runUpdate()
      check('registry unreachable: exits non-zero', exitCode === 1, String(exitCode))
      check(
        'registry unreachable: explains why',
        stderr.some((l) => l.toLowerCase().includes('registry')),
        stderr.join('\n')
      )
    }
    setDistTags({ latest: '1.0.0' })

    // --- pnpm-only: detects, targets --allow-build for native pkgs only ----------
    resetNpm()
    enablePnpm()
    disableBun()
    clearInstallLogs()
    seed(pnpmRoot, '@slayzone/cli', '1.0.0') // no native deps
    seed(pnpmRoot, '@slayzone/hub', '0.9.0') // native deps
    setDistTags({ latest: '1.1.0' })
    {
      const { stdout } = await runUpdate()
      const log = readLog(pnpmInstallLog)
      check('pnpm-only: reports via the pnpm manager column', stdout.some((l) => l.includes('pnpm')), stdout.join('\n'))
      check(
        'pnpm-only: --allow-build is set for hub (native deps)',
        log.some((l) => l.includes('--allow-build=@slayzone/hub')),
        log.join('|')
      )
      check(
        'pnpm-only: --allow-build is NOT set for cli (no native deps)',
        !log.some((l) => l.includes('--allow-build=@slayzone/cli')),
        log.join('|')
      )
      check(
        'pnpm-only: installs both outdated packages at the target version',
        log.some((l) => l.includes('@slayzone/cli@1.1.0')) && log.some((l) => l.includes('@slayzone/hub@1.1.0')),
        log.join('|')
      )
      check('pnpm-only: never touches npm install', readLog(npmInstallLog).length === 0)
    }
    disablePnpm()

    // --- bun-only: detects, sets --trust for native pkgs only --------------------
    resetNpm()
    enableBun()
    clearInstallLogs()
    seed(bunGlobalNodeModules, '@slayzone/runner', '0.9.0') // native deps
    setDistTags({ latest: '1.0.0' })
    {
      const { stdout } = await runUpdate()
      const log = readLog(bunInstallLog)
      check('bun-only: reports via the bun manager column', stdout.some((l) => l.includes('bun')), stdout.join('\n'))
      check('bun-only: --trust is set for runner (native deps)', log.some((l) => l.includes('--trust')), log.join('|'))
      check(
        'bun-only: installs the outdated package at the target version',
        log.some((l) => l.includes('@slayzone/runner@1.0.0')),
        log.join('|')
      )
    }

    // --- bun-only, cli (no native deps): no --trust flag --------------------------
    resetNpm()
    enableBun() // fresh bun root — the previous case's runner must not leak in here
    clearInstallLogs()
    seed(bunGlobalNodeModules, '@slayzone/cli', '0.9.0')
    setDistTags({ latest: '1.0.0' })
    {
      await runUpdate()
      const log = readLog(bunInstallLog)
      check('bun-only, cli: no --trust flag (no native deps)', !log.some((l) => l.includes('--trust')), log.join('|'))
    }
    disableBun()

    // --- same package found via two managers at once: tracked independently -----
    resetNpm()
    enablePnpm()
    clearInstallLogs()
    seed(npmRoot, '@slayzone/hub', '0.9.0') // outdated
    seed(pnpmRoot, '@slayzone/hub', '1.0.0') // already current
    setDistTags({ latest: '1.0.0' })
    {
      const { stdout } = await runUpdate()
      check(
        'dual-manager: both rows show up in the report',
        stdout.filter((l) => l.includes('@slayzone/hub')).length >= 2,
        stdout.join('\n')
      )
      check(
        'dual-manager: only the outdated (npm) copy gets installed',
        readLog(npmInstallLog).some((l) => l.includes('@slayzone/hub@1.0.0')) &&
          readLog(pnpmInstallLog).length === 0
      )
    }
    disablePnpm()

    // --- no manager available at all => clean failure ------------------------------
    resetNpm()
    disablePnpm()
    disableBun()
    process.env.FAKE_NPM_ROOT_FAIL = '1'
    {
      const { exitCode, stderr } = await runUpdate()
      check('no manager available: exits non-zero', exitCode === 1, String(exitCode))
      check(
        'no manager available: names all three',
        stderr.some((l) => l.includes('npm') && l.includes('pnpm') && l.includes('bun')),
        stderr.join('\n')
      )
    }
    delete process.env.FAKE_NPM_ROOT_FAIL
  } finally {
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
    rmSync(workDir, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
