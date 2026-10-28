/**
 * `slay computer` end-to-end against a REAL hub.
 *
 * Drives the BUILT `slay` bundle: boots a real hub in a throwaway root, mints a join
 * token, then runs `slay computer create` and asserts the computer actually ENROLLS —
 * token decode → computer.config.json write → spawn → pinned dial → `mode:"enroll"`. The
 * library pieces are unit-tested elsewhere (platform/src/service-unit.test.ts for
 * unit CONTENT, computer/src/join-token.test.ts for the token codec); what only an
 * end-to-end run can catch is the wiring.
 *
 * The happy path's token is minted by `slay computer mint` rather than by this file's
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
 * WHY THE ASSERTIONS LOOK DIFFERENT FROM hub-lifecycle.test.ts: a computer binds no port
 * and serves no `/health`. There is nothing to probe. Its success signal is its own
 * stdout (`"mode":"enroll"`), its identity is its unit file, and its liveness comes
 * from the supervisor — so the checks here read logs and unit files where the hub suite
 * reads `/health`.
 *
 * ISOLATION — must never touch the real dev/prod stores:
 *   - every `SLAYZONE_*` / `ELECTRON_*` var is scrubbed from child envs (a supervised
 *     parent leaks SLAYZONE_ROOT → the real dev store);
 *   - the hub and every computer get `SLAYZONE_ROOT` under one throwaway mkdtemp dir;
 *   - the hub binds `127.0.0.1:0` (OS-assigned) so it cannot collide with — or be
 *     mistaken for — a developer's real hub, and nothing here discovers hubs by name;
 *   - names carry a pid-unique prefix, which every unit-dir assertion filters on.
 *
 * Native ABI: the hub bundle needs better-sqlite3 and the computer needs node-pty, both
 * built for Electron's ABI, so both run under `ELECTRON_RUN_AS_NODE=1 electron` (as
 * does this suite, under vitest.harness.config.ts). The CLI bundle is plain node.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
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
import { BOOTSTRAP_OWNER_EMAIL } from '@slayzone/platform/hub-owner-file'
import { decodeJoinToken } from '@slayzone/platform/join-token'
import { readServiceLogTail } from '../service'

// Package roots are derived from the REPO root rather than this file's own URL: the
// CLI package typechecks as CommonJS (see its tsconfig `module`), where `import.meta`
// is a compile error, even though the suite is executed as ESM. Anchored on cwd, which
// run-all.sh invokes from the repo root.
const REPO_ROOT = process.env.SLZ_REPO_ROOT ?? process.cwd()
const CLI_DIR = resolve(REPO_ROOT, 'packages/apps/cli')
const HUB_DIR = resolve(REPO_ROOT, 'packages/apps/hub')
const COMPUTER_DIR = resolve(REPO_ROOT, 'packages/apps/computer')
const CLI_BIN = join(CLI_DIR, 'dist', 'slay.js')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const COMPUTER_BIN = join(COMPUTER_DIR, 'dist', 'bin.cjs')

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

/** Pid-unique so a developer's real computers can never be listed or removed by us. */
const NAME_PREFIX = `slztest-${process.pid}-`

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
 * The sandbox is not hygiene, it is required: a standalone computer installs agent
 * hooks at boot, and those targets are deliberately anchored on $HOME rather than
 * on the computer's root (one `~/.claude/settings.json` per machine can hold only
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
/** Computer pids the CLI detached; killed in the teardown so none survives the suite. */
const spawnedComputerPids: number[] = []

/** Boot a real hub on an OS-assigned loopback port in its own throwaway root. */
async function startHub(): Promise<{ port: number; root: string }> {
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
      SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
      // Login on: the mint cases below go through the bootstrap-owner bearer.
      SLAYZONE_HUB_REQUIRE_LOGIN: '1',
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
  expect(match, `hub listening line parseable: ${listen}`).not.toBeNull()
  const port = Number(match![1])
  await poll(
    async () => {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000)
      })
      return r.ok ? true : null
    },
    30_000,
    'hub /health ok'
  )
  return { port, root }
}

/**
 * The bootstrap owner's bearer, read from `hub.owner.json` under this hub's
 * own root. Every standalone hub enforces auth on `/api/computers/join-token`
 * unconditionally now (`joinTokenAuthDecision` requires a verified bearer from
 * EVERY caller, loopback included, once auth is required) — a bare loopback
 * `fetch` with no Authorization header gets 401, not 200, so this must be
 * read and sent explicitly. Polled because `ensureBootstrapOwner` writes the
 * file asynchronously after boot, not synchronously before the listen line.
 */
async function readOwnerToken(root: string): Promise<string> {
  const owner = await poll(
    async () => {
      const raw = readFileSync(join(root, 'hub.owner.json'), 'utf-8')
      return JSON.parse(raw) as { token?: string }
    },
    15_000,
    'hub.owner.json written'
  )
  expect(typeof owner.token, 'owner token present').toBe('string')
  expect(owner.token!.length, 'owner token present').toBeGreaterThan(0)
  return owner.token!
}

/** Mint a single-use join token over the hub's loopback REST channel. */
async function mintToken(port: number, root: string, label: string): Promise<string> {
  const ownerToken = await readOwnerToken(root)
  // The route 503s until the /computers listener has bound, hence the poll.
  const tok = await poll(
    async () => {
      const r = await fetch(`http://127.0.0.1:${port}/api/computers/join-token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${ownerToken}`
        },
        // T-20: on a hub with login a token is minted FOR a named user — here the
        // bootstrap owner, who then owns the computer.
        body: JSON.stringify({ label, forUser: BOOTSTRAP_OWNER_EMAIL })
      })
      if (r.status !== 200) return null
      return (await r.json()) as { token: string }
    },
    25_000,
    'join-token mint (computer listener bound)'
  )
  expect(tok.token.startsWith('szjt1.'), `szjt1 token, got ${tok.token.slice(0, 12)}…`).toBe(true)
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

describe('slay computer — end-to-end against a real hub', () => {
  let backend: ServiceBackend
  let rejectRoot = ''
  let computerRoot = ''
  let workDir = ''
  let orphanRoot = ''

  beforeAll(() => {
    if (!existsSync(CLI_DIR) || !existsSync(HUB_DIR) || !existsSync(COMPUTER_DIR)) {
      throw new Error(
        `cannot locate packages under ${REPO_ROOT} — run from the repo root, or set SLZ_REPO_ROOT`
      )
    }
    ensureBuilt(HUB_DIR, HUB_BIN, 'hub')
    ensureBuilt(COMPUTER_DIR, COMPUTER_BIN, 'computer')
    ensureBuilt(CLI_DIR, CLI_BIN, 'cli')
    TMP = mkdtempSync(join(tmpdir(), 'slz-computerctl-'))
    backend = detectBackend()

    rejectRoot = join(TMP, 'reject')
    mkdirSync(rejectRoot, { recursive: true })
    computerRoot = join(TMP, 'computer-root')
    workDir = join(TMP, 'work')
    orphanRoot = join(TMP, 'orphan-root')
  })

  afterAll(async () => {
    for (const pid of spawnedComputerPids) {
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
  })

  // ---------------------------------------------------------------- rejections
  // All decided before anything is written, so none of these can install a unit.

  test('create requires --token (a computer cannot reach any hub without one)', async () => {
    const res = slayNoService(['computer', 'create', `${NAME_PREFIX}notoken`], rejectRoot)
    expect(res.status, 'exited non-zero').not.toBe(0)
    expect(res.stderr, `names the missing option: ${res.stderr}`).toMatch(
      /required option.*--token/i
    )
  })

  test('create rejects a malformed token BEFORE writing anything', async () => {
    const res = slayNoService(
      [
        'computer',
        'create',
        `${NAME_PREFIX}badtok`,
        '--token',
        'not-a-token',
        '--root',
        rejectRoot
      ],
      rejectRoot
    )
    expect(res.status, `exited non-zero (stdout: ${res.stdout})`).not.toBe(0)
    expect(res.stderr, `explains why: ${res.stderr}`).toMatch(/not a valid SlayZone join token/)
    // The whole point of failing fast: no computer.config.json, no unit, nothing to clean up.
    expect(
      existsSync(join(rejectRoot, 'computer.config.json')),
      'no computer.config.json written'
    ).toBe(false)
    expect(leakedUnits(backend).length, 'no unit written').toBe(0)
  })

  test('create refuses the reserved local-computer name', async () => {
    // The hub collapses every enroll named `local-computer` onto one deterministic id
    // (the desktop app's co-located computer), so a second one would hijack that row.
    const fake = `szjt1.${Buffer.from(
      JSON.stringify({ hubUrl: 'ws://127.0.0.1:1/computers', secret: 's' })
    ).toString('base64url')}`
    const res = slayNoService(
      ['computer', 'create', 'local-computer', '--token', fake, '--root', rejectRoot],
      rejectRoot
    )
    expect(res.status, 'exited non-zero').not.toBe(0)
    expect(res.stderr, `explains: ${res.stderr}`).toMatch(
      /reserved for the computer inside the SlayZone/
    )
    expect(
      existsSync(join(rejectRoot, 'computer.config.json')),
      'no computer.config.json written'
    ).toBe(false)
  })

  test('a computer that exits at once fails create fast and leaves no root state', async () => {
    // SLZ_FORCE_NO_SERVICE takes the unsupervised branch (nothing registered), and
    // SLZ_COMPUTER_BIN points at a bundle that exits at once. Nothing restarts it, so
    // `create` must say so then — not after polling its log for the enroll deadline.
    const deadRoot = join(TMP, 'dead-computer')
    mkdirSync(deadRoot, { recursive: true })
    const deadBin = join(TMP, 'exiting-computer-bin.js')
    writeFileSync(deadBin, 'console.error("simulated computer crash"); process.exit(1);\n')
    const fake = `szjt1.${Buffer.from(
      JSON.stringify({ hubUrl: 'ws://127.0.0.1:1/computers', secret: 's' })
    ).toString('base64url')}`
    const started = Date.now()
    const res = slay(
      ['computer', 'create', `${NAME_PREFIX}dead`, '--token', fake, '--root', deadRoot],
      { root: deadRoot, env: { SLZ_FORCE_NO_SERVICE: '1', SLZ_COMPUTER_BIN: deadBin } }
    )
    expect(Date.now() - started, 'gave up as soon as the computer exited').toBeLessThan(10_000)
    expect(res.status, `exited non-zero (stdout: ${res.stdout})`).not.toBe(0)
    expect(res.stderr, `surfaced the child's own error: ${res.stderr}`).toMatch(
      /simulated computer crash/
    )
    expect(
      existsSync(join(deadRoot, 'computer.config.json')),
      'the failed first boot was rolled back'
    ).toBe(false)
  })

  test('create refuses a duplicate name, pointing at start/rm', async () => {
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
        kind: 'computer',
        name,
        root: rejectRoot,
        command: NODE_BIN,
        args: [COMPUTER_BIN],
        logDir: join(rejectRoot, 'logs')
      },
      backend
    )
    try {
      const fake = `szjt1.${Buffer.from(
        JSON.stringify({ hubUrl: 'ws://127.0.0.1:1/computers', secret: 's' })
      ).toString('base64url')}`
      const res = slay(['computer', 'create', name, '--token', fake, '--root', rejectRoot], {
        root: rejectRoot
      })
      expect(res.status, `exited non-zero (stdout: ${res.stdout})`).not.toBe(0)
      expect(res.stderr, res.stderr).toMatch(new RegExp(`computer named "${name}" already exists`))
      expect(res.stderr, 'points at start').toMatch(/slay computer start/)
      expect(res.stderr, 'points at rm').toMatch(/slay computer rm/)
    } finally {
      removeUnit('computer', name, backend)
    }
  })

  for (const verb of ['start', 'stop', 'rm', 'restart', 'logs']) {
    test(`${verb} on an unknown computer fails with a create hint`, async () => {
      if (backend === 'none') {
        console.log('    (skipped — no user service manager on this platform)')
        return
      }
      const res = slay(['computer', verb, `${NAME_PREFIX}ghost`], { root: rejectRoot })
      expect(res.status, `exited non-zero (stdout: ${res.stdout})`).not.toBe(0)
      expect(res.stderr, `names it: ${res.stderr}`).toMatch(
        new RegExp(`No computer named "${NAME_PREFIX}ghost"`)
      )
    })
  }

  test('ls on a machine with no test computers lists none of ours', async () => {
    const res = slay(['computer', 'ls', '--json'], { root: rejectRoot })
    expect(res.status, `exited 0 (stderr: ${res.stderr})`).toBe(0)
    // `none` backend prints a plain sentence rather than JSON — accept either, since
    // what matters is that nothing of OURS is listed.
    const mine = res.stdout.trimStart().startsWith('[')
      ? (JSON.parse(res.stdout) as Array<{ name: string }>).filter((r) =>
          r.name.startsWith(NAME_PREFIX)
        )
      : []
    expect(mine.length, `no test computers listed, got ${JSON.stringify(mine)}`).toBe(0)
  })

  // ---------------------------------------------------------------- happy path
  // `SLZ_FORCE_NO_SERVICE=1` takes the unsupervised detached-spawn branch, so this
  // exercises the ENTIRE chain — token decode → computer.config.json → spawn → pinned dial →
  // enroll — while installing no service unit.

  describe('against a real hub', () => {
    let hub: { port: number; root: string }
    beforeAll(async () => {
      hub = await startHub()

      // ------------------------------------------------------------------- mint
      // `computer mint` is the ONLY place a computer's hub is chosen — the token embeds
      // that hub's dial url, and `create` merely decodes it. These
      // cases run before the happy path on purpose: the token `create` then uses is
      // the one MINT produced, so a divergence between the CLI channel and the raw
      // REST one shows up as a failed enroll rather than passing unnoticed.

      // Wait out the listener bind once, so the mint cases below aren't racing it.
      await mintToken(hub.port, hub.root, `${NAME_PREFIX}warmup`)
    })

    test('mint --json prints a decodable token for the addressed hub', async () => {
      const res = slay(
        ['--hub', String(hub.port), 'computer', 'mint', '--json', '--for', BOOTSTRAP_OWNER_EMAIL],
        { root: rejectRoot }
      )
      expect(res.status, `exited 0 (stderr: ${res.stderr})`).toBe(0)
      const out = JSON.parse(res.stdout) as { token: string; hubUrl: string }
      expect(out.token.startsWith('szjt1.'), `szjt1 token, got ${out.token.slice(0, 12)}…`).toBe(
        true
      )
      expect(out.hubUrl, 'names the hub it minted on').toBe(`ws://127.0.0.1:${hub.port}/computers`)
      // The decoded payload must agree with the reported hubUrl — that equality is
      // what makes `computer ls`'s HUB column and `create`'s decode trustworthy.
      const decoded = decodeJoinToken(out.token)
      expect(decoded, 'token decodes').not.toBe(null)
      expect(decoded!.hubUrl, 'embedded url matches the reported one').toBe(out.hubUrl)
    })

    test('mint warns that a loopback hub token is same-machine only', async () => {
      const res = slay(
        [
          '--hub',
          String(hub.port),
          'computer',
          'mint',
          `${NAME_PREFIX}warn`,
          '--for',
          BOOTSTRAP_OWNER_EMAIL
        ],
        { root: rejectRoot }
      )
      expect(res.status, `exited 0 (stderr: ${res.stderr})`).toBe(0)
      // A hub with no public address always embeds loopback. Silence here is how an operator
      // carries a dead token to another machine and gets no explanation.
      expect(res.stdout, `warns + names the fix: ${res.stdout}`).toMatch(/loopback address/)
      expect(res.stdout, `warns + names the fix: ${res.stdout}`).toMatch(/public-address/)
    })

    test('mint rejects a non-positive --ttl before calling the hub', async () => {
      const res = slay(['--hub', String(hub.port), 'computer', 'mint', '--ttl', '0'], {
        root: rejectRoot
      })
      expect(res.status, 'exited non-zero').not.toBe(0)
      expect(res.stderr, `names the bad flag: ${res.stderr}`).toMatch(/Invalid --ttl/)
    })

    test('mint on a hub with login refuses without --for and says how (T-20)', async () => {
      const res = slay(['--hub', String(hub.port), 'computer', 'mint', '--json'], {
        root: rejectRoot
      })
      expect(res.status, 'exited non-zero').not.toBe(0)
      expect(res.stderr, `names --for: ${res.stderr}`).toMatch(/--for <email>/)
    })

    // The token the happy path uses comes from the CLI, closing the loop: if
    // `computer mint` and the raw REST mint ever disagree, the enroll below fails.
    describe('with a CLI-minted token', () => {
      let token: string
      beforeAll(async () => {
        token = await (async () => {
          const res = slay(
            [
              '--hub',
              String(hub.port),
              'computer',
              'mint',
              '--json',
              '--for',
              BOOTSTRAP_OWNER_EMAIL
            ],
            { root: rejectRoot }
          )
          expect(res.status, `mint for the happy path exited 0 (stderr: ${res.stderr})`).toBe(0)
          return (JSON.parse(res.stdout) as { token: string }).token
        })()
        mkdirSync(computerRoot, { recursive: true })
        mkdirSync(workDir, { recursive: true })
      })
      const computerName = `${NAME_PREFIX}e2e`

      test('create enrolls a computer into the hub and records its config', async () => {
        const res = slayNoService(
          [
            'computer',
            'create',
            computerName,
            '--token',
            token,
            '--root',
            computerRoot,
            '--allow',
            workDir
          ],
          computerRoot
        )
        const pid = /pid (\d+)/.exec(res.stdout)?.[1]
        if (pid) spawnedComputerPids.push(Number(pid))
        expect(res.status, `exited 0 (stdout: ${res.stdout}\nstderr: ${res.stderr})`).toBe(0)
        expect(res.stdout, `reports the hub link: ${res.stdout}`).toMatch(/reached its hub/)

        // The token, hub url, name and path-jail all travel via computer.config.json — none has
        // an env channel, and a unit file must never carry a credential.
        const cfg = JSON.parse(
          readFileSync(join(computerRoot, 'computer.config.json'), 'utf8')
        ) as Record<string, unknown>
        expect(cfg.joinToken, 'token persisted').toBe(token)
        expect(cfg.computerName, 'name persisted').toBe(computerName)
        expect(cfg.hubUrl, 'hub url decoded from the token').toBe(
          `ws://127.0.0.1:${hub.port}/computers`
        )
        expect(
          Array.isArray(cfg.allowedRoots),
          `--allow reached the path-jail: ${JSON.stringify(cfg.allowedRoots)}`
        ).toBe(true)
        expect(
          (cfg.allowedRoots as string[])[0],
          `--allow reached the path-jail: ${JSON.stringify(cfg.allowedRoots)}`
        ).toBe(workDir)
      })

      test('computer.config.json is 0600 — it holds the join token', async () => {
        if (process.platform === 'win32') {
          console.log('    (skipped — POSIX mode bits are not enforced on Windows)')
          return
        }
        const mode = statSync(join(computerRoot, 'computer.config.json')).mode & 0o777
        expect(mode.toString(8), 'owner-only').toBe('600')
      })

      test('the computer actually enrolled (credentials on disk, mode:enroll logged)', async () => {
        // A FRESH computer must ENROLL, not hello-reconnect: `enroll` is what proves the
        // join token was accepted and credentials were minted over the link.
        const logs = readdirSync(join(computerRoot, 'logs'))
          .map((f) => readFileSync(join(computerRoot, 'logs', f), 'utf8'))
          .join('\n')
        expect(logs, `enroll logged:\n${logs.slice(-1500)}`).toMatch(/"mode":"enroll"/)
        // The durable record: the dialer persists {computerId, apiKey} per hub host into
        // one shared map file, which is what `computer ls` reads for its ENROLLED column.
        const creds = JSON.parse(
          readFileSync(join(computerRoot, 'computer.state.json'), 'utf8')
        ) as Record<string, unknown>
        expect(
          Object.keys(creds).length,
          `credential entry written, got ${JSON.stringify(creds)}`
        ).toBeGreaterThan(0)
      })

      test('the hub reports the computer as connected', async () => {
        // The other side of the same fact — proves the enroll reached the hub's store,
        // not just that the computer believed it did.
        const health = await poll(
          async () => {
            const r = await fetch(`http://127.0.0.1:${hub.port}/health`)
            if (!r.ok) return null
            const body = (await r.json()) as { computersConnected?: number }
            return (body.computersConnected ?? 0) > 0 ? body : null
          },
          20_000,
          'hub reports a connected computer'
        )
        expect(
          health.computersConnected ?? 0,
          `computersConnected: ${health.computersConnected}`
        ).toBeGreaterThanOrEqual(1)
      })

      test('create refuses a second computer under a name it already spawned', async () => {
        // Even on the unsupervised path a duplicate must be refused — otherwise a second
        // detached computer would race the first for the same root and credentials. With no
        // unit file to consult, the computer.config.json already naming this computer is the record.
        const res = slayNoService(
          ['computer', 'create', computerName, '--token', token, '--root', computerRoot],
          computerRoot
        )
        const pid = /pid (\d+)/.exec(res.stdout)?.[1]
        if (pid) spawnedComputerPids.push(Number(pid))
        expect(res.status, `exited non-zero (stdout: ${res.stdout})`).not.toBe(0)
        // On this path the refusal comes from computer.config.json's `computerName`, not a unit
        // file — that is the whole point: with no service manager there is no unit to
        // consult, and an unguarded second create silently spawned a rival computer.
        expect(res.stderr, `refused by root occupancy: ${res.stderr}`).toMatch(
          new RegExp(`already installed in .* — "${computerName}"`)
        )
        expect(res.stderr, `points at start: ${res.stderr}`).toMatch(/slay computer start/)
      })

      test('create refuses a DIFFERENT name in an occupied root too', async () => {
        // Keyed on the ROOT, not the name: two computers sharing a root would share
        // computer.config.json and the credential store and fight over both.
        const res = slayNoService(
          ['computer', 'create', `${NAME_PREFIX}second`, '--token', token, '--root', computerRoot],
          computerRoot
        )
        const pid = /pid (\d+)/.exec(res.stdout)?.[1]
        if (pid) spawnedComputerPids.push(Number(pid))
        expect(res.status, `exited non-zero (stdout: ${res.stdout})`).not.toBe(0)
        expect(res.stderr, `suggests a separate root: ${res.stderr}`).toMatch(/--root <dir>/)
      })

      // --------------------------------------------- the config-only wedge (regression)
      //
      // THE BUG: a `create` with no supervisor available writes computer.config.json and
      // no unit. From then on `create` refused ("already installed in <root>") while
      // `start`/`stop`/`rm` refused ("No computer named X") — two different existence
      // oracles, and NO command could resolve the state. Recovery was `rm -rf` by hand.
      // Hit for real on a VPS whose XDG_RUNTIME_DIR was unset (see service-unit.ts).
      //
      // Built by writing the config directly: that is exactly the on-disk residue the
      // broken path left, and it needs no spawned process to reproduce.
      const orphanName = `${NAME_PREFIX}orphan`
      test('a config-only computer is VISIBLE to ls (it used to be invisible)', async () => {
        mkdirSync(orphanRoot, { recursive: true })
        writeFileSync(
          join(orphanRoot, 'computer.config.json'),
          JSON.stringify({
            computerName: orphanName,
            hubUrl: `ws://127.0.0.1:${hub.port}/computers`
          }),
          { mode: 0o600 }
        )
        const res = slayNoService(['computer', 'ls'], orphanRoot)
        expect(res.status, `ls exits 0 (stderr: ${res.stderr})`).toBe(0)
        expect(res.stdout, `lists the config-only computer: ${res.stdout}`).toMatch(
          new RegExp(orphanName)
        )
        // "unmanaged", not "stopped": `start` has to REGISTER it, not merely resume it,
        // and calling that "stopped" would misdescribe what happens next.
        expect(res.stdout, `marks it unmanaged: ${res.stdout}`).toMatch(/unmanaged/)
      })

      test('ls --json stays machine-readable with no service manager', async () => {
        // Regression: the no-backend branch printed prose on stdout even under --json,
        // so anything parsing the list broke on exactly the boxes that needed it.
        const res = slayNoService(['computer', 'ls', '--json'], orphanRoot)
        expect(res.status, `exits 0 (stderr: ${res.stderr})`).toBe(0)
        const parsed: unknown = JSON.parse(res.stdout)
        expect(Array.isArray(parsed), `stdout parses as JSON array: ${res.stdout}`).toBe(true)
      })

      test('rm recovers a config-only computer — the dead end is gone', async () => {
        const res = slayNoService(['computer', 'rm', orphanName, '--purge'], orphanRoot)
        expect(res.status, `rm succeeds (stderr: ${res.stderr})`).toBe(0)
        expect(
          existsSync(join(orphanRoot, 'computer.config.json')),
          '--purge deleted the root that was blocking re-create'
        ).toBe(false)
        // The precise old failure. Its absence IS the fix.
        expect(
          res.stderr,
          `no longer claims the computer does not exist: ${res.stderr}`
        ).not.toMatch(/No computer named/)
      })

      test('rm without --purge keeps the operator’s credentials', async () => {
        mkdirSync(orphanRoot, { recursive: true })
        const cfg = join(orphanRoot, 'computer.config.json')
        writeFileSync(cfg, JSON.stringify({ computerName: orphanName }), { mode: 0o600 })
        const res = slayNoService(['computer', 'rm', orphanName], orphanRoot)
        expect(res.status, `rm succeeds (stderr: ${res.stderr})`).toBe(0)
        expect(existsSync(cfg), 'a plain rm never deletes the root — that is operator data').toBe(
          true
        )
        rmSync(orphanRoot, { recursive: true, force: true })
      })

      test('the enroll wait reads journald for a systemd unit, not the log dir', async () => {
        // REGRESSION (Linux only, shipped): a systemd unit declares
        // StandardOutput=journal and writes NOTHING to the log dir, but the enroll wait
        // polled only `<root>/logs/*.log`. So `computer create`/`start` could never
        // succeed under systemd — it waited out the full 30s and reported "did not
        // reach its hub" plus "No output was captured" for a computer that had connected.
        //
        // It passed everywhere it was exercised: launchd writes real files
        // (StandardOutPath), and this suite forces the unsupervised path, which
        // redirects to a file too. Only systemd was broken and only systemd was
        // uncovered — so assert the SOURCE SELECTION directly rather than the wait.
        const logRoot = join(TMP, 'logsrc-root')
        mkdirSync(join(logRoot, 'logs'), { recursive: true })
        writeFileSync(join(logRoot, 'logs', 'computer.out.log'), 'connected {"mode":"enroll"}\n')

        // No unit named ⇒ file source ⇒ finds the marker.
        expect(
          readServiceLogTail('computer', logRoot, 200),
          'file source reads the log dir'
        ).toMatch(/"mode":"enroll"/)
        // A unit named ⇒ journald source. This unit does not exist, so the read yields
        // '' — and crucially NOT the file content sitting right there. Returning the
        // file would be the bug: the wait would pass by reading a stale artifact
        // instead of the unit's real output.
        expect(
          readServiceLogTail('computer', logRoot, 200, 'slayzone-computer-nonexistent.service'),
          'journald source never falls back to the log dir'
        ).toBe('')
      })

      // ------------------------------------------------------------------- cleanliness
      test('nothing here installed a service unit', async () => {
        expect(
          leakedUnits(backend).join(','),
          'no unit file carrying this test’s name prefix survives'
        ).toBe('')
      })
    })
  })
})
