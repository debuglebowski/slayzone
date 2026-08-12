/**
 * ONE ANSWER TO "DOES THIS RUNNER EXIST".
 *
 * THE BUG THIS MODULE EXISTS TO KILL. `create` asked the ROOT (`runner.config.json`
 * names a runner) while `start`/`stop`/`rm`/`restart`/`logs` asked the UNIT FILE, and
 * the code treated those as the same question. They diverge the moment a `create`
 * runs with no supervisor available: root state is written, no unit is, and from then
 * on `create` refuses ("already installed") while `start` refuses ("not registered").
 * No command could reach that state — recovery was `rm -rf` by hand.
 *
 * WHY THE UNIT FILE WAS NEVER A REGISTRY. It was doing double duty: supervision
 * artifact AND machine-wide index of what exists here. It is absent exactly when
 * there is no supervisor, so the index vanishes while the runner keeps running. The
 * hub avoids this by binding a port — `discoverHubs()` sweeps the block and finds
 * hubs no matter who started them. A runner binds nothing, which is what left
 * enumeration leaning on units (`runner.ts`: "with no port to sweep, enumeration IS
 * the listing"). That sentence was the defect.
 *
 * WHAT REPLACES IT. Three INDEPENDENT facts, never collapsed:
 *
 *   installed   `<ROOT>/runner.config.json` names it       — local, per-root
 *   supervised  a unit file exists                          — local, per-machine
 *   enrolled    a hub issued it credentials                 — remote, authoritative
 *
 * The hub is the only supervisor-independent registry a runner has, and it already
 * exists for product reasons (`runners.list` powers Settings → Runners), so nothing
 * new is invented and CLI and UI cannot drift. It is queried BEST-EFFORT: a runner
 * whose hub is unreachable must still be listable and removable, so hub data enriches
 * the local picture and never gates it.
 *
 * @module cli/commands/runner-identity
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadRunnerConfigFile } from '@slayzone/platform/slayzone-config'
import { discoverHubs } from '@slayzone/platform/hub-discovery'
import {
  listRegisteredUnits,
  readUnitRoot,
  unitPath,
  type ServiceBackend
} from '@slayzone/platform/service-unit'
import { resolveHubTarget } from '../hub-config'
import { supervisorStatus } from '../service'

/** `<ROOT>/runner.config.json` for a runner rooted at `root`. */
export function configPathFor(root: string): string {
  return join(root, 'runner.config.json')
}

/**
 * The root a bare command acts on: `SLAYZONE_ROOT` when set, else the working
 * directory. Identical to how the runner binary anchors itself
 * (`runner/src/bin.ts` seeds `SLAYZONE_ROOT = cwd`), which is what makes the CLI
 * and the runner agree on where a given runner's state lives. Using cwd alone
 * would miss a runner whose root was named by the environment.
 */
export function ambientRoot(): string {
  return process.env.SLAYZONE_ROOT ?? process.cwd()
}

/**
 * Everything known about one runner name on this machine, from every source that
 * has an opinion. Each flag is independently true or false — a runner can be
 * installed but unsupervised (the wedge), supervised but never enrolled (bad token,
 * crash-looping), or enrolled but no longer present locally (moved, or `rm`'d here
 * without being revoked there).
 */
export interface RunnerFacts {
  name: string
  /** From the unit when registered, else the root whose config claims this name. */
  root: string | null
  /** `<ROOT>/runner.config.json` names this runner. */
  installed: boolean
  /** A launchd/systemd unit exists for it. */
  supervised: boolean
  /** It holds hub credentials — it reached a hub at least once. */
  enrolled: boolean
  /** The supervisor reports a live process. Always false without a supervisor. */
  running: boolean
  /** The hub reports a live socket. `null` when no hub could be asked. */
  connected: boolean | null
  /** Hub dial URL from its local config, when known. */
  hubUrl: string | null
}

/** A runner row as the hub sees it. */
interface HubRunnerRow {
  name: string
  connected: boolean
}

/**
 * Whether this runner holds credentials for a hub — i.e. it enrolled at least once.
 * The dialer writes `<ROOT>/runner.state.json` (0600, `{hubHost: creds}`) after a
 * successful enroll, so a non-empty map there is the durable local record.
 *
 * This separates "installed but never reached its hub" (bad token, unreachable hub,
 * crash-looping unit) from "enrolled, currently offline".
 */
export function isEnrolled(root: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'runner.state.json'), 'utf8'))
    return typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0
  } catch {
    return false
  }
}

/**
 * Ask the ambient hub which runners it knows. Best-effort by CONTRACT: any failure
 * yields `null` and every caller degrades to local-only.
 *
 * DELIBERATELY NOT `resolveHubRequestTarget` + `hubRequest`. Both call the CLI's
 * `fail()`, which is `process.exit(1)` — a `try/catch` cannot intercept that, so
 * routing through them would make `slay runner ls` die outright whenever no hub is
 * running, several are (ambiguous target), or the hub is older than this endpoint.
 * Enumerating what is on THIS machine must never depend on a network call
 * succeeding, and "which hub did you mean" is not a question `ls` should ever ask.
 * The same hazard is documented for `getServerPort()` in `hub.ts`.
 *
 * A configured target (`--hub`, `SLAYZONE_HUB_ADDRESS`, `slay hub use`) wins. Failing
 * that, a SINGLE discovered hub is used; several means no unambiguous answer, so the
 * hub source is simply skipped rather than guessed at.
 */
async function hubRunners(): Promise<HubRunnerRow[] | null> {
  let baseUrl: string
  let token: string | null = null
  try {
    const configured = resolveHubTarget()
    if (configured) {
      baseUrl = configured.baseUrl
      token = configured.token
    } else {
      const running = await discoverHubs()
      if (running.length !== 1) return null
      baseUrl = `http://127.0.0.1:${running[0]!.port}`
    }
  } catch {
    return null
  }
  try {
    const res = await fetch(`${baseUrl}/api/computers`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(3000)
    })
    // A 404 means the hub predates this endpoint — an ordinary version skew during a
    // rollout, not an error worth surfacing. Degrade exactly as if it were offline.
    if (!res.ok) return null
    const rows: unknown = await res.json()
    return Array.isArray(rows) ? (rows as HubRunnerRow[]) : null
  } catch {
    return null
  }
}

/** Local facts for one name, given a known root. Pure disk + supervisor reads. */
function localFacts(
  name: string,
  root: string | null,
  backend: ServiceBackend,
  supervised: boolean
): Omit<RunnerFacts, 'connected'> {
  const cfg = root ? loadRunnerConfigFile(configPathFor(root)) : {}
  return {
    name,
    root,
    installed: cfg.runnerName !== undefined,
    supervised,
    enrolled: root ? isEnrolled(root) : false,
    running: supervised ? supervisorStatus('runner', backend, name).running : false,
    hubUrl: cfg.hubUrl ?? null
  }
}

/**
 * Find the root of a runner that has no unit, by inspecting a candidate directory.
 *
 * Only ever the CWD (or an explicit `--root`): a config-only runner leaves no
 * machine-wide trace, so there is nowhere else to look. That is a real limit of the
 * unsupervised path, not an oversight — and it is why `create` writing both records
 * or neither (see `runner.ts`) matters more than any amount of scanning.
 */
function rootClaims(root: string, name: string): boolean {
  return loadRunnerConfigFile(configPathFor(root)).runnerName === name
}

/**
 * Resolve one runner by name across every source.
 *
 * `cwd` is consulted so a config-only runner in the current directory is found even
 * with no unit — the exact state that used to be unreachable. Pass `hub: false` to
 * skip the network entirely (lifecycle commands that only need local truth).
 */
export async function resolveRunner(
  name: string,
  backend: ServiceBackend,
  opts: { cwd?: string; hub?: boolean } = {}
): Promise<RunnerFacts> {
  const cwd = opts.cwd ?? ambientRoot()
  const supervised = backend !== 'none' && existsSync(unitPath('runner', name, backend))
  // Unit root wins: it is the registration's own record of where the runner lives,
  // and it stays correct when the operator runs the command from somewhere else.
  const root = supervised
    ? readUnitRoot('runner', name, backend)
    : rootClaims(cwd, name)
      ? cwd
      : null
  const local = localFacts(name, root, backend, supervised)
  if (opts.hub === false) return { ...local, connected: null }
  const rows = await hubRunners()
  const row = rows?.find((r) => r.name === name) ?? null
  return {
    ...local,
    // A hub that knows this runner proves enrollment even when the local state file
    // is gone (root deleted, machine rebuilt) — so OR the two rather than trusting
    // disk alone.
    enrolled: local.enrolled || row !== null,
    connected: rows === null ? null : (row?.connected ?? false)
  }
}

/**
 * Every runner this machine knows about, from all three sources unioned by name.
 *
 * `hubReachable: false` tells the caller to render enrollment as unknown rather than
 * absent — claiming "not enrolled" because the hub was down would be the list lying
 * in precisely the situation someone is debugging.
 */
export async function listRunners(
  backend: ServiceBackend,
  opts: { cwd?: string } = {}
): Promise<{ runners: RunnerFacts[]; hubReachable: boolean }> {
  const cwd = opts.cwd ?? ambientRoot()
  const names = new Set<string>()

  if (backend !== 'none') {
    for (const u of listRegisteredUnits('runner', backend)) names.add(u.name)
  }
  // The CWD's own config — how a config-only (unsupervised) runner gets listed at all.
  const cwdName = loadRunnerConfigFile(configPathFor(cwd)).runnerName
  if (cwdName !== undefined) names.add(cwdName)

  const rows = await hubRunners()
  for (const r of rows ?? []) names.add(r.name)

  const runners: RunnerFacts[] = []
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const supervised = backend !== 'none' && existsSync(unitPath('runner', name, backend))
    const root = supervised
      ? readUnitRoot('runner', name, backend)
      : rootClaims(cwd, name)
        ? cwd
        : null
    const local = localFacts(name, root, backend, supervised)
    const row = rows?.find((r) => r.name === name) ?? null
    runners.push({
      ...local,
      enrolled: local.enrolled || row !== null,
      connected: rows === null ? null : (row?.connected ?? false)
    })
  }
  return { runners, hubReachable: rows !== null }
}

/**
 * True when this machine has no record of the name at all. The ONLY condition under
 * which a lifecycle command may refuse: any single source knowing it means there is
 * something to act on, and refusing then is what produced the unrecoverable wedge.
 */
export function isUnknown(facts: RunnerFacts): boolean {
  return !facts.installed && !facts.supervised && !facts.enrolled
}
