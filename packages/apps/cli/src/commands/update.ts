/**
 * `slay update` — bump globally installed @slayzone packages, across npm, pnpm,
 * and bun.
 *
 * Three install paths exist for the hub/runner/cli trio, and only one of them is
 * NOT already self-updating:
 *   - the CLI's own private runtime prefix (`<dataDir>/${kind}-runtime`,
 *     `../service.ts:resolveServiceBin`) auto-(re)installs hub/runner pinned to
 *     the running CLI's own version; `slay hub|runner restart <name> --upgrade`
 *     already re-triggers that resolution.
 *   - the desktop app's bundled `slay` (symlinked from
 *     `SlayZone.app/Contents/Resources/bin/slay`) updates via the app's own
 *     auto-updater, not npm.
 *   - a plain global install (`npm install -g` / `pnpm add -g` / `bun add -g`
 *     `@slayzone/cli|hub|runner` — the standalone/headless path documented in
 *     each package's published README, npm-only there) is pinned forever —
 *     nothing re-checks or bumps it. That is what this command is for. pnpm/bun
 *     are covered too since either is a plausible choice for someone setting up
 *     a headless box even though only npm is documented.
 *
 * Scope is deliberately narrow: only global installs, and only reinstall — never
 * restart a live hub/runner (that can drop terminals/agents mid-session), so a
 * restart stays a printed hint the operator runs themselves.
 *
 * A package can be found under more than one manager at once (e.g. installed via
 * both npm and pnpm) — each (manager, package) pair is tracked and updated
 * independently; nothing here assumes exclusivity.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { listRegisteredUnits, type ServiceKind } from '@slayzone/platform/service-unit'
import { fail, resolveBackend } from '../service'

const PACKAGE_NAMES = ['@slayzone/cli', '@slayzone/runner', '@slayzone/hub'] as const
type PackageName = (typeof PACKAGE_NAMES)[number]

/** Which `ServiceKind` a package's registered units live under — cli has none.
 *  Doubles as "has native deps that need an install-time rebuild" (better-sqlite3
 *  / node-pty): exactly the two packages with a ServiceKind. */
const KIND_FOR_PACKAGE: Partial<Record<PackageName, ServiceKind>> = {
  '@slayzone/hub': 'hub',
  '@slayzone/runner': 'runner'
}

type ManagerId = 'npm' | 'pnpm' | 'bun'

interface Manager {
  id: ManagerId
  bin: string
  /** This manager's global `node_modules` root, or null if unavailable. */
  globalRoot(): string | null
  /** argv (excluding the bin name) for a global install of `names@target`. */
  installArgs(names: PackageName[], target: string): string[]
}

/** Run `bin args…`, capturing trimmed stdout — null on any failure (missing
 *  binary, non-zero exit, …). Used for both `root -g` lookups and dist-tag reads. */
function runCapture(bin: string, args: string[]): string | null {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/**
 * bun has no `root -g` equivalent (`bun pm bin -g` prints the BIN dir, not
 * node_modules). Its global packages live at `$BUN_INSTALL/install/global/node_modules`
 * — `$BUN_INSTALL` defaults to `~/.bun` — confirmed against a real bun 1.3 install;
 * this is bun's documented global-install layout, not a guess.
 */
function bunGlobalRoot(): string | null {
  const base = process.env.BUN_INSTALL || join(homedir(), '.bun')
  const dir = join(base, 'install', 'global', 'node_modules')
  return existsSync(dir) ? dir : null
}

const MANAGERS: Manager[] = [
  {
    id: 'npm',
    bin: 'npm',
    globalRoot: () => runCapture('npm', ['root', '-g']),
    installArgs: (names, target) => ['install', '-g', ...names.map((n) => `${n}@${target}`)]
  },
  {
    id: 'pnpm',
    bin: 'pnpm',
    globalRoot: () => runCapture('pnpm', ['root', '-g']),
    // pnpm prompts interactively (or silently skips, off a TTY) before running a
    // global package's install scripts — `--allow-build=<name>` pre-approves it,
    // needed for hub/runner's native rebuild (better-sqlite3/node-pty). Verified
    // via `pnpm add --help` (10.30.3); harmless to pass for cli, which has none.
    installArgs: (names, target) => [
      'add',
      '-g',
      ...names.filter((n) => KIND_FOR_PACKAGE[n]).map((n) => `--allow-build=${n}`),
      ...names.map((n) => `${n}@${target}`)
    ]
  },
  {
    id: 'bun',
    bin: 'bun',
    globalRoot: bunGlobalRoot,
    // Same problem as pnpm's build gate, bun's own flavor: postinstall scripts
    // don't run for a package unless it's trusted. `--trust` opts the packages
    // in this install into that list. Verified via `bun add --help` (1.3.6).
    installArgs: (names, target) => [
      'add',
      '-g',
      ...(names.some((n) => KIND_FOR_PACKAGE[n]) ? ['--trust'] : []),
      ...names.map((n) => `${n}@${target}`)
    ]
  }
]

/** The version a package is installed at under `globalRoot`, or null if absent/unreadable. */
function readInstalledVersion(globalRoot: string, pkg: PackageName): string | null {
  const pkgJsonPath = join(globalRoot, ...pkg.split('/'), 'package.json')
  if (!existsSync(pkgJsonPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { version?: string }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

interface DistTags {
  latest?: string
  beta?: string
  [tag: string]: string | undefined
}

/**
 * The registry's dist-tags for the trio (published together, same version).
 * Registry data, not manager-specific — `npm view` and `pnpm view` return the
 * identical JSON shape (verified), so either answers this; bun has no equivalent
 * command with a confirmed-compatible output, so it's not tried here.
 */
function fetchDistTags(): DistTags | null {
  for (const bin of ['npm', 'pnpm']) {
    const out = runCapture(bin, ['view', '@slayzone/cli', 'dist-tags', '--json'])
    if (!out) continue
    try {
      return JSON.parse(out) as DistTags
    } catch {
      /* try the next one */
    }
  }
  return null
}

interface FoundPackage {
  manager: ManagerId
  name: PackageName
  installedVersion: string
}

/**
 * Point at any registered (launchd/systemd) hub or runner units backed by a
 * package that just got bumped — informational only, never auto-restarted.
 */
function printRestartHints(updatedPackages: PackageName[]): void {
  const backend = resolveBackend()
  if (backend === 'none') return
  const hints: string[] = []
  for (const pkg of updatedPackages) {
    const kind = KIND_FOR_PACKAGE[pkg]
    if (!kind) continue
    for (const unit of listRegisteredUnits(kind, backend)) {
      hints.push(`  slay ${kind} restart ${unit.name} --upgrade`)
    }
  }
  if (hints.length === 0) return
  console.log('\nRestart to apply:')
  for (const hint of hints) console.log(hint)
}

export function updateCommand(): Command {
  const cmd = new Command('update')
    .description('Update globally installed @slayzone packages (cli, hub, runner) — npm, pnpm, or bun')
    .option('--check', 'Report available updates without installing anything')
    .action((opts: { check?: boolean }) => {
      const roots = new Map<ManagerId, string>()
      for (const mgr of MANAGERS) {
        const root = mgr.globalRoot()
        if (root) roots.set(mgr.id, root)
      }
      if (roots.size === 0) {
        fail('Could not resolve a global install root for npm, pnpm, or bun. Is at least one on PATH?')
      }

      const found: FoundPackage[] = []
      for (const [manager, root] of roots) {
        for (const name of PACKAGE_NAMES) {
          const installedVersion = readInstalledVersion(root, name)
          if (installedVersion) found.push({ manager, name, installedVersion })
        }
      }

      if (found.length === 0) {
        console.log('No @slayzone packages found in any global npm, pnpm, or bun install.')
        return
      }

      const distTags = fetchDistTags()
      if (!distTags) {
        fail(
          'Could not reach the npm registry to check for updates ' +
            '(`npm view @slayzone/cli dist-tags` and `pnpm view` both failed).'
        )
      }

      // Follow whichever channel is currently in use: a prerelease version (has a
      // "-") means the operator is on beta, since `latest` never points at a
      // prerelease (npm rejects that tag on one — see scripts/publish-npm.sh).
      const onPrerelease = found.some((p) => p.installedVersion.includes('-'))
      const target = (onPrerelease ? distTags.beta : undefined) ?? distTags.latest ?? distTags.beta
      if (!target) fail('The registry returned no usable dist-tag for @slayzone/cli.')

      const managerW = Math.max('MANAGER'.length, ...found.map((p) => p.manager.length))
      const nameW = Math.max('PACKAGE'.length, ...found.map((p) => p.name.length))
      const versionW = Math.max('INSTALLED'.length, ...found.map((p) => p.installedVersion.length))
      console.log(
        `${'MANAGER'.padEnd(managerW)}  ${'PACKAGE'.padEnd(nameW)}  ${'INSTALLED'.padEnd(versionW)}  STATUS`
      )
      for (const p of found) {
        const status = p.installedVersion === target ? 'up to date' : `-> ${target}`
        console.log(
          `${p.manager.padEnd(managerW)}  ${p.name.padEnd(nameW)}  ` +
            `${p.installedVersion.padEnd(versionW)}  ${status}`
        )
      }

      const outdated = found.filter((p) => p.installedVersion !== target)
      if (outdated.length === 0) {
        console.log('\nEverything is up to date.')
        return
      }

      if (opts.check) {
        console.log('\n--check: nothing installed. Run `slay update` to apply.')
        return
      }

      const byManager = new Map<ManagerId, PackageName[]>()
      for (const p of outdated) {
        const list = byManager.get(p.manager) ?? []
        list.push(p.name)
        byManager.set(p.manager, list)
      }

      for (const [managerId, names] of byManager) {
        const mgr = MANAGERS.find((m) => m.id === managerId)
        if (!mgr) continue // unreachable: managerId always comes from MANAGERS
        const args = mgr.installArgs(names, target)
        console.log(`\n[${managerId}] Installing: ${names.map((n) => `${n}@${target}`).join(' ')}`)
        try {
          execFileSync(mgr.bin, args, { stdio: 'inherit' })
        } catch {
          fail(
            `${mgr.bin} install failed. Install the packages yourself and retry:\n` +
              names.map((n) => `  ${mgr.bin} ${mgr.id === 'npm' ? 'install' : 'add'} -g ${n}@${target}`).join('\n')
          )
        }
      }

      printRestartHints(outdated.map((p) => p.name))
    })
  return cmd
}
