/**
 * `slay runner` end-to-end against a REAL hub.
 *
 * Drives the BUILT `slay` bundle: boots a real hub in a throwaway root, mints a join
 * token, then runs `slay runner create` and asserts the runner actually ENROLLS —
 * token decode → runner.config.json write → spawn → pinned dial → `mode:"enroll"`. The
 * library pieces are unit-tested elsewhere (platform/src/service-unit.test.ts for
 * unit CONTENT, runner/src/join-token.test.ts for the token codec); what only an
 * end-to-end run can catch is the wiring.
 *
 * The happy path's token is minted by `slay runner mint` rather than by this file's
 * raw `fetch` — the two channels must agree about what a token contains, and making
 * the enroll depend on the CLI one is what proves it. `mintToken()` (raw fetch)
 * stays, as the independent reference the mint cases compare against and to absorb
 * the listener-bind wait once.
 *
 * DELIBERATELY NEVER REGISTERS A SERVICE. Every case runs with
 * `SLZ_FORCE_NO_SERVICE=1` (⇒ the unsupervised detached-spawn branch) or fails before
 * anything is written, so no launchd/systemd unit is ever installed on the machine
 * running the suite. The ONE case that needs a unit file to exist (duplicate-name
 * detection) writes it with `writeUnit` — pure filesystem, never handed to
 * `launchctl`/`systemctl` — and removes it again; the final case asserts the unit dir
 * is clean. The register-and-start path is a documented manual check per OS, same as
 * the hub's.
 *
 * WHY THE ASSERTIONS LOOK DIFFERENT FROM hub-lifecycle.test.ts: a runner binds no port
 * and serves no `/health`. There is nothing to probe. Its success signal is its own
 * stdout (`"mode":"enroll"`), its identity is its unit file, and its liveness comes
 * from the supervisor — so the checks here read logs and unit files where the hub suite
 * reads `/health`.
 *
 * ISOLATION — must never touch the real dev/prod stores:
 *   - every `SLAYZONE_*` / `ELECTRON_*` var is scrubbed from child envs (a supervised
 *     parent leaks SLAYZONE_ROOT → the real dev store);
 *   - the hub and every runner get `SLAYZONE_ROOT` under one throwaway mkdtemp dir;
 *   - the hub binds `127.0.0.1:0` (OS-assigned) so it cannot collide with — or be
 *     mistaken for — a developer's real hub, and nothing here discovers hubs by name;
 *   - names carry a pid-unique prefix, which every unit-dir assertion filters on.
 *
 * Native ABI: the hub bundle needs better-sqlite3 and the runner needs node-pty, both
 * built for Electron's ABI, so both run under `ELECTRON_RUN_AS_NODE=1 electron`
 * (run_test_electron_strict_loader in run-all.sh). The CLI bundle is plain node.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   packages/apps/cli/src/commands/runner-lifecycle.test.ts
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  defaultUnitDir,
  detectBackend,
  removeUnit,
  unitPath,
  writeUnit,
  type ServiceBackend
} from '@slayzone/platform/service-unit'
import { decodeJoinToken } from '@slayzone/platform/join-token'

// Package roots are derived from the REPO root rather than this file's own URL: the
// CLI package typechecks as CommonJS (see its tsconfig `module`), where `import.meta`
// is a compile error, even though the suite is executed as ESM. Anchored on cwd, which
// run-all.sh invokes from the repo root.
const REPO_ROOT = process.env.SLZ_REPO_ROOT ?? process.cwd()
const CLI_DIR = resolve(REPO_ROOT, 'packages/apps/cli')
const HUB_DIR = resolve(REPO_ROOT, 'packages/apps/hub')
const RUNNER_DIR = resolve(REPO_ROOT, 'packages/apps/runner')
const CLI_BIN = join(CLI_DIR, 'dist', 'slay.js')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const RUNNER_BIN = join(RUNNER_DIR, 'dist', 'bin.cjs')

/**
 * The REAL Electron executable, not `node_modules/.bin/electron` — that is a Node shim
 * which spawns the binary as a CHILD, so a pid we held would be the shim's rather than
 * the process we actually started. `electron/path.txt` holds the platform-correct
 * relative path (a .app bundle on macOS, a bare executable elsewhere).
 */
const ELECTRON_BIN = resolve(
  REPO_ROOT,
  'node_modules/electron/dist',
  readFileSync(resolve(REPO_ROOT, 'node_modules/electron/path.txt'), 'utf8').trim()
)

/** A real `node` for running the CLI — see the note on `slay()`. */
const NODE_BIN = process.env.SLZ_TEST_NODE ?? 'node'

/** Pid-unique so a developer's real runners can never be listed or removed by us. */
const NAME_PREFIX = `slztest-${process.pid}-`

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
    failed++
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}

/** Newest mtime under a dir tree (stale-build detection). */
function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

/** (Re)build a bundle when its output is missing or older than any source file. */
function ensureBuilt(pkgDir: string, bin: string, label: string): void {
  let needs = !existsSync(bin)
  if (!needs) needs = newestMtime(join(pkgDir, 'src')) > statSync(bin).mtimeMs
  if (!needs) return
  console.log(`  … building ${label} bundle (missing or stale)`)
  execFileSync('node', ['build.mjs'], { cwd: pkgDir, stdio: 'inherit' })
  if (!existsSync(bin)) throw new Error(`${label} build did not produce ${bin}`)
}

/**
 * Inherited env minus every SLAYZONE_/ELECTRON_ key, plus a sandbox for every
 * MACHINE-WIDE install target.
 *
 * The sandbox is not hygiene, it is required: a standalone runner installs agent
 * hooks at boot, and those targets are deliberately anchored on $HOME rather than
 * on the runner's root (one `~/.claude/settings.json` per machine can hold only
 * one notify.sh path). Scrubbing SLAYZONE_* alone therefore does NOT isolate them
 * — it just puts them back on their real defaults, so this suite would rewrite
 * the developer's actual ~/.slayzone and ~/.claude/settings.json.
 */
function scrubbedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (/^(SLAYZONE_|ELECTRON_)/.test(k)) continue
    out[k] = v
  }
  const box = join(TMP, 'machine')
  out.SLAYZONE_MACHINE_DIR = join(box, '.slayzone')
  out.SLAYZONE_CLAUDE_SETTINGS_PATH = join(box, '.claude', 'settings.json')
  out.SLAYZONE_CODEX_HOOKS_PATH = join(box, '.codex', 'hooks.json')
  out.SLAYZONE_GEMINI_SETTINGS_PATH = join(box, '.gemini', 'settings.json')
  out.SLAYZONE_ANTIGRAVITY_HOOKS_PATH = join(box, '.gemini', 'config', 'hooks.json')
  out.SLAYZONE_OPENCODE_PLUGIN_PATH = join(box, '.config', 'opencode', 'plugin', 'slayzone.js')
  return out
}

/**
 * Run the built `slay` with a scrubbed env.
 *
 * Uses PLAIN NODE, not `process.execPath`: this suite runs under Electron (the hub
 * bundle needs its native ABI), so execPath is the Electron binary — and since the
 * scrubbed env drops `ELECTRON_RUN_AS_NODE`, running the CLI through it would launch a
 * GUI app that never exits and hang the suite.
 */
function slay(
  args: string[],
  opts: { root?: string; env?: Record<string, string> } = {}
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(NODE_BIN, [CLI_BIN, ...args], {
    encoding: 'utf8',
    // Never hang the suite: a wedged CLI call fails the case instead.
    timeout: 90_000,
    env: {
      ...scrubbedEnv(),
      ...(opts.root ? { SLAYZONE_ROOT: opts.root } : {}),
      ...(opts.env ?? {})
    }
  })
  if (res.error) throw new Error(`slay ${args.join(' ')} failed to run: ${res.error.message}`)
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/** `slay` with the unsupervised branch forced — installs no service unit. */
function slayNoService(args: string[], root: string): ReturnType<typeof slay> {
  return slay(args, { root, env: { SLZ_FORCE_NO_SERVICE: '1' } })
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number, label: string): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v != null) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

let TMP = ''
let hubProc: ChildProcess | null = null
const hubLogs: string[] = []
/** Runner pids the CLI detached; killed in the teardown so none survives the suite. */
const spawnedRunnerPids: number[] = []

/** Boot a real hub on an OS-assigned loopback port in its own throwaway root. */
async function startHub(): Promise<{ port: number }> {
  const root = join(TMP, 'hub-root')
  mkdirSync(root, { recursive: true })
  const secret = execFileSync(NODE_BIN, [
    '-e',
    'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
  ]).toString()
  const proc = spawn(ELECTRON_BIN, [HUB_BIN], {
    cwd: root,
    env: {
      ...scrubbedEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      SLAYZONE_ROOT: root,
      // `:0` — the OS picks the port, so this hub is outside the block a developer's
      // real hubs live in and can never be confused with one.
      SLAYZONE_HUB_ADDRESS: '127.0.0.1:0',
      SLAYZONE_HUB_AUTH_SECRET: secret
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  hubProc = proc
  const cap = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) hubLogs.push(line)
  }
  proc.stdout?.on('data', cap)
  proc.stderr?.on('data', cap)

  const listen = await poll(
    async () => {
      if (proc.exitCode !== null) {
        throw new Error(`hub exited during boot:\n${hubLogs.slice(-15).join('\n')}`)
      }
      return hubLogs.find((l) => l.includes('listening on http://')) ?? null
    },
    40_000,
    'hub listening line'
  )
  const match = /listening on http:\/\/[^:]+:(\d+)/.exec(listen)
  assert(match, `hub listening line parseable: ${listen}`)
  const port = Number(match![1])
  await poll(
    async () => {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })
      return r.ok ? true : null
    },
    30_000,
    'hub /health ok'
  )
  return { port }
}

/** Mint a single-use join token over the hub's loopback REST channel. */
async function mintToken(port: number, label: string): Promise<string> {
  // The route 503s until the /runners listener has bound, hence the poll.
  const tok = await poll(
    async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/runners/join-token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label })
      })
      if (r.status !== 200) return null
      return (await r.json()) as { token: string }
    },
    25_000,
    'join-token mint (runner listener bound)'
  )
  assert(tok.token.startsWith('szjt1.'), `szjt1 token, got ${tok.token.slice(0, 12)}…`)
  return tok.token
}

/** Unit files in the real unit dir carrying this test's name prefix. */
function leakedUnits(backend: ServiceBackend): string[] {
  if (backend === 'none') return []
  try {
    return readdirSync(defaultUnitDir(backend)).filter((f) => f.includes(NAME_PREFIX))
  } catch {
    return []
  }
}

async function main(): Promise<void> {
  console.log('\nslay runner — end-to-end against a real hub\n')

  if (!existsSync(CLI_DIR) || !existsSync(HUB_DIR) || !existsSync(RUNNER_DIR)) {
    throw new Error(
      `cannot locate packages under ${REPO_ROOT} — run from the repo root, or set SLZ_REPO_ROOT`
    )
  }
  ensureBuilt(HUB_DIR, HUB_BIN, 'hub')
  ensureBuilt(RUNNER_DIR, RUNNER_BIN, 'runner')
  ensureBuilt(CLI_DIR, CLI_BIN, 'cli')
  TMP = mkdtempSync(join(tmpdir(), 'slz-runnerctl-'))
  const backend = detectBackend()

  try {
    // ---------------------------------------------------------------- rejections
    // All decided before anything is written, so none of these can install a unit.

    const rejectRoot = join(TMP, 'reject')
    mkdirSync(rejectRoot, { recursive: true })

    await test('create requires --token (a runner cannot reach any hub without one)', async () => {
      const res = slayNoService(['runner', 'create', `${NAME_PREFIX}notoken`], rejectRoot)
      assert(res.status !== 0, 'exited non-zero')
      assert(
        /required option.*--token/i.test(res.stderr),
        `names the missing option: ${res.stderr}`
      )
    })

    await test('create rejects a malformed token BEFORE writing anything', async () => {
      const res = slayNoService(
        ['runner', 'create', `${NAME_PREFIX}badtok`, '--token', 'not-a-token', '--root', rejectRoot],
        rejectRoot
      )
      assert(res.status !== 0, `exited non-zero (stdout: ${res.stdout})`)
      assert(/not a valid SlayZone join token/.test(res.stderr), `explains why: ${res.stderr}`)
      // The whole point of failing fast: no runner.config.json, no unit, nothing to clean up.
      assert(!existsSync(join(rejectRoot, 'runner.config.json')), 'no runner.config.json written')
      assertEq(leakedUnits(backend).length, 0, 'no unit written')
    })

    await test('create refuses the reserved local-runner name', async () => {
      // The hub collapses every enroll named `local-runner` onto one deterministic id
      // (the desktop app's co-located runner), so a second one would hijack that row.
      const fake = `szjt1.${Buffer.from(
        JSON.stringify({ hubUrl: 'ws://127.0.0.1:1/runners', certFingerprint: 'ab', secret: 's' })
      ).toString('base64url')}`
      const res = slayNoService(
        ['runner', 'create', 'local-runner', '--token', fake, '--root', rejectRoot],
        rejectRoot
      )
      assert(res.status !== 0, 'exited non-zero')
      assert(/reserved for the runner inside the SlayZone/.test(res.stderr), `explains: ${res.stderr}`)
      assert(!existsSync(join(rejectRoot, 'runner.config.json')), 'no runner.config.json written')
    })

    await test('create refuses a duplicate name, pointing at start/rm', async () => {
      if (backend === 'none') {
        console.log('    (skipped — no user service manager on this platform)')
        return
      }
      // Writes a unit FILE only; it is never handed to launchctl/systemctl, so the
      // supervisor never learns about it. Removed immediately, and the last case in
      // this suite asserts the unit dir is clean.
      const name = `${NAME_PREFIX}dup`
      writeUnit(
        {
          kind: 'runner',
          name,
          root: rejectRoot,
          command: NODE_BIN,
          args: [RUNNER_BIN],
          logDir: join(rejectRoot, 'logs')
        },
        backend
      )
      try {
        const fake = `szjt1.${Buffer.from(
          JSON.stringify({ hubUrl: 'ws://127.0.0.1:1/runners', certFingerprint: 'ab', secret: 's' })
        ).toString('base64url')}`
        const res = slay(['runner', 'create', name, '--token', fake, '--root', rejectRoot], {
          root: rejectRoot
        })
        assert(res.status !== 0, `exited non-zero (stdout: ${res.stdout})`)
        assert(new RegExp(`runner named "${name}" already exists`).test(res.stderr), res.stderr)
        assert(/slay runner start/.test(res.stderr), 'points at start')
        assert(/slay runner rm/.test(res.stderr), 'points at rm')
      } finally {
        removeUnit('runner', name, backend)
      }
    })

    for (const verb of ['start', 'stop', 'rm', 'restart', 'logs']) {
      await test(`${verb} on an unknown runner fails with a create hint`, async () => {
        if (backend === 'none') {
          console.log('    (skipped — no user service manager on this platform)')
          return
        }
        const res = slay(['runner', verb, `${NAME_PREFIX}ghost`], { root: rejectRoot })
        assert(res.status !== 0, `exited non-zero (stdout: ${res.stdout})`)
        assert(
          new RegExp(`No runner named "${NAME_PREFIX}ghost"`).test(res.stderr),
          `names it: ${res.stderr}`
        )
      })
    }

    await test('ls on a machine with no test runners lists none of ours', async () => {
      const res = slay(['runner', 'ls', '--json'], { root: rejectRoot })
      assertEq(res.status, 0, `exited 0 (stderr: ${res.stderr})`)
      // `none` backend prints a plain sentence rather than JSON — accept either, since
      // what matters is that nothing of OURS is listed.
      const mine = res.stdout.trimStart().startsWith('[')
        ? (JSON.parse(res.stdout) as Array<{ name: string }>).filter((r) =>
            r.name.startsWith(NAME_PREFIX)
          )
        : []
      assertEq(mine.length, 0, `no test runners listed, got ${JSON.stringify(mine)}`)
    })

    // ---------------------------------------------------------------- happy path
    // `SLZ_FORCE_NO_SERVICE=1` takes the unsupervised detached-spawn branch, so this
    // exercises the ENTIRE chain — token decode → runner.config.json → spawn → pinned dial →
    // enroll — while installing no service unit.

    const hub = await startHub()

    // ------------------------------------------------------------------- mint
    // `runner mint` is the ONLY place a runner's hub is chosen — the token embeds
    // that hub's dial url + cert fingerprint, and `create` merely decodes it. These
    // cases run before the happy path on purpose: the token `create` then uses is
    // the one MINT produced, so a divergence between the CLI channel and the raw
    // REST one shows up as a failed enroll rather than passing unnoticed.

    // Wait out the listener bind once, so the mint cases below aren't racing it.
    await mintToken(hub.port, `${NAME_PREFIX}warmup`)

    await test('mint --json prints a decodable token for the addressed hub', async () => {
      const res = slay(['--hub', String(hub.port), 'runner', 'mint', '--json'], {
        root: rejectRoot
      })
      assertEq(res.status, 0, `exited 0 (stderr: ${res.stderr})`)
      const out = JSON.parse(res.stdout) as { token: string; hubUrl: string }
      assert(out.token.startsWith('szjt1.'), `szjt1 token, got ${out.token.slice(0, 12)}…`)
      assertEq(out.hubUrl, `ws://127.0.0.1:${hub.port}/runners`, 'names the hub it minted on')
      // The decoded payload must agree with the reported hubUrl — that equality is
      // what makes `runner ls`'s HUB column and `create`'s decode trustworthy.
      const decoded = decodeJoinToken(out.token)
      assert(decoded !== null, 'token decodes')
      assertEq(decoded!.hubUrl, out.hubUrl, 'embedded url matches the reported one')
    })

    await test('mint warns that a loopback hub token is same-machine only', async () => {
      const res = slay(['--hub', String(hub.port), 'runner', 'mint', `${NAME_PREFIX}warn`], {
        root: rejectRoot
      })
      assertEq(res.status, 0, `exited 0 (stderr: ${res.stderr})`)
      // A local-mode hub always embeds loopback. Silence here is how an operator
      // carries a dead token to another machine and gets no explanation.
      assert(
        /loopback address/.test(res.stdout) && /public-address/.test(res.stdout),
        `warns + names the fix: ${res.stdout}`
      )
    })

    await test('mint rejects a non-positive --ttl before calling the hub', async () => {
      const res = slay(['--hub', String(hub.port), 'runner', 'mint', '--ttl', '0'], {
        root: rejectRoot
      })
      assert(res.status !== 0, 'exited non-zero')
      assert(/Invalid --ttl/.test(res.stderr), `names the bad flag: ${res.stderr}`)
    })

    // The token the happy path uses comes from the CLI, closing the loop: if
    // `runner mint` and the raw REST mint ever disagree, the enroll below fails.
    const token = await (async () => {
      const res = slay(['--hub', String(hub.port), 'runner', 'mint', '--json'], {
        root: rejectRoot
      })
      assertEq(res.status, 0, `mint for the happy path exited 0 (stderr: ${res.stderr})`)
      return (JSON.parse(res.stdout) as { token: string }).token
    })()
    const runnerRoot = join(TMP, 'runner-root')
    const workDir = join(TMP, 'work')
    mkdirSync(runnerRoot, { recursive: true })
    mkdirSync(workDir, { recursive: true })
    const runnerName = `${NAME_PREFIX}e2e`

    await test('create enrolls a runner into the hub and records its config', async () => {
      const res = slayNoService(
        [
          'runner',
          'create',
          runnerName,
          '--token',
          token,
          '--root',
          runnerRoot,
          '--allow',
          workDir
        ],
        runnerRoot
      )
      const pid = /pid (\d+)/.exec(res.stdout)?.[1]
      if (pid) spawnedRunnerPids.push(Number(pid))
      assertEq(res.status, 0, `exited 0 (stdout: ${res.stdout}\nstderr: ${res.stderr})`)
      assert(/reached its hub/.test(res.stdout), `reports the hub link: ${res.stdout}`)

      // The token, hub url, name and path-jail all travel via runner.config.json — none has
      // an env channel, and a unit file must never carry a credential.
      const cfg = JSON.parse(readFileSync(join(runnerRoot, 'runner.config.json'), 'utf8')) as Record<
        string,
        unknown
      >
      assertEq(cfg.joinToken, token, 'token persisted')
      assertEq(cfg.runnerName, runnerName, 'name persisted')
      assertEq(cfg.hubUrl, `ws://127.0.0.1:${hub.port}/runners`, 'hub url decoded from the token')
      assert(
        Array.isArray(cfg.allowedRoots) && (cfg.allowedRoots as string[])[0] === workDir,
        `--allow reached the path-jail: ${JSON.stringify(cfg.allowedRoots)}`
      )
    })

    await test('runner.config.json is 0600 — it holds the join token', async () => {
      if (process.platform === 'win32') {
        console.log('    (skipped — POSIX mode bits are not enforced on Windows)')
        return
      }
      const mode = statSync(join(runnerRoot, 'runner.config.json')).mode & 0o777
      assertEq(mode.toString(8), '600', 'owner-only')
    })

    await test('the runner actually enrolled (credentials on disk, mode:enroll logged)', async () => {
      // A FRESH runner must ENROLL, not hello-reconnect: `enroll` is what proves the
      // join token was accepted and credentials were minted over the link.
      const logs = readdirSync(join(runnerRoot, 'logs'))
        .map((f) => readFileSync(join(runnerRoot, 'logs', f), 'utf8'))
        .join('\n')
      assert(/"mode":"enroll"/.test(logs), `enroll logged:\n${logs.slice(-1500)}`)
      // The durable record: the dialer persists {runnerId, apiKey} per hub host into
      // one shared map file, which is what `runner ls` reads for its ENROLLED column.
      const creds = JSON.parse(readFileSync(join(runnerRoot, 'runner.state.json'), 'utf8')) as Record<
        string,
        unknown
      >
      assert(Object.keys(creds).length > 0, `credential entry written, got ${JSON.stringify(creds)}`)
    })

    await test('the hub reports the runner as connected', async () => {
      // The other side of the same fact — proves the enroll reached the hub's store,
      // not just that the runner believed it did.
      const health = await poll(
        async () => {
          const r = await fetch(`http://127.0.0.1:${hub.port}/health`)
          if (!r.ok) return null
          const body = (await r.json()) as { runnersConnected?: number }
          return (body.runnersConnected ?? 0) > 0 ? body : null
        },
        20_000,
        'hub reports a connected runner'
      )
      assert((health.runnersConnected ?? 0) >= 1, `runnersConnected: ${health.runnersConnected}`)
    })

    await test('create refuses a second runner under a name it already spawned', async () => {
      // Even on the unsupervised path a duplicate must be refused — otherwise a second
      // detached runner would race the first for the same root and credentials. With no
      // unit file to consult, the runner.config.json already naming this runner is the record.
      const res = slayNoService(
        ['runner', 'create', runnerName, '--token', token, '--root', runnerRoot],
        runnerRoot
      )
      const pid = /pid (\d+)/.exec(res.stdout)?.[1]
      if (pid) spawnedRunnerPids.push(Number(pid))
      assert(res.status !== 0, `exited non-zero (stdout: ${res.stdout})`)
      // On this path the refusal comes from runner.config.json's `runnerName`, not a unit
      // file — that is the whole point: with no service manager there is no unit to
      // consult, and an unguarded second create silently spawned a rival runner.
      assert(
        new RegExp(`already installed in .* — "${runnerName}"`).test(res.stderr),
        `refused by root occupancy: ${res.stderr}`
      )
      assert(/slay runner start/.test(res.stderr), `points at start: ${res.stderr}`)
    })

    await test('create refuses a DIFFERENT name in an occupied root too', async () => {
      // Keyed on the ROOT, not the name: two runners sharing a root would share
      // runner.config.json and the credential store and fight over both.
      const res = slayNoService(
        ['runner', 'create', `${NAME_PREFIX}second`, '--token', token, '--root', runnerRoot],
        runnerRoot
      )
      const pid = /pid (\d+)/.exec(res.stdout)?.[1]
      if (pid) spawnedRunnerPids.push(Number(pid))
      assert(res.status !== 0, `exited non-zero (stdout: ${res.stdout})`)
      assert(/--root <dir>/.test(res.stderr), `suggests a separate root: ${res.stderr}`)
    })

    // ------------------------------------------------------------------- cleanliness
    await test('nothing here installed a service unit', async () => {
      assertEq(
        leakedUnits(backend).join(','),
        '',
        'no unit file carrying this test’s name prefix survives'
      )
    })
  } finally {
    for (const pid of spawnedRunnerPids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    if (hubProc && hubProc.exitCode === null) {
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          try {
            hubProc?.kill('SIGKILL')
          } catch {
            /* gone */
          }
          res()
        }, 3_000)
        hubProc?.once('exit', () => {
          clearTimeout(t)
          res()
        })
        try {
          hubProc?.kill('SIGTERM')
        } catch {
          clearTimeout(t)
          res()
        }
      })
    }
    if (TMP) rmSync(TMP, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
