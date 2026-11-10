/**
 * Migration persona harness — runs INSIDE the harness container, against TODAY's code.
 *
 *   node harness.cjs <persona.json> <input.tar.gz> <out dir>
 *
 * 1. Unpack the persona's frozen input (written by an OLD release) into $HOME, and a
 *    second, read-only reference copy for the invariants.
 * 2. Replay the desktop app's boot exactly as `packages/apps/app/src/main/index.ts`
 *    runs it, minus Electron: the XDG move, `initStorageDir` (rename + channel copy +
 *    omgslayzone + userData copy + icons), the diagnostics DB, the client-settings
 *    move, the v127 disk move and the agent-hook installers. Every step is the app's
 *    OWN function, imported from its source.
 * 3. Start today's hub(s) and computer(s) as the app/standalone users start them, wait
 *    until every computer of the topology is connected and the databases go quiet,
 *    then stop them gracefully (computers first).
 * 4. Write a normalized dump of every database and data file to <out>, plus the
 *    invariants — properties that must hold for every persona, whatever the golden
 *    output says. Exit 2 when an invariant fails.
 *
 * Desktop-boot parity: the order and env below mirror index.ts (storage at module load,
 * then diagnostics → client settings → v127 → hub sidecar → local computer → hooks) and
 * sidecar-server-supervisor.ts / the local-computer spawn. Keep them in sync.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import Database from 'better-sqlite3'
import {
  getClientRoot,
  getDbName,
  getDiagnosticsDbName,
  getStateDir,
  getSupervisedRoot,
  HUB_PROCESS_ENV,
  migrateXdgIfNeeded,
  SIDECAR_FIXED_PORT
} from '../../../packages/shared/platform/src/index'
import {
  installAntigravityHooks,
  installClaudeHooks,
  installCodexHooks,
  installGeminiHooks,
  installNotifyScript,
  installOpencodePlugin,
  uninstallCodexWrapper
} from '../../../packages/shared/platform/src/agent-hooks/index'
import { initStorageDir, resolveLegacyStateDir } from '../../../packages/apps/app/src/main/data-paths'
import { migrateClientSettings } from '../../../packages/apps/app/src/main/client-settings-migration'
import { migrateV127DiskDir } from '../../../packages/apps/app/src/main/db/v127-disk-migration'
import { selfHealDiagnosticsDb } from '../../../packages/domains/diagnostics/src/server/self-heal'
import {
  applyDiagnosticsPragmas,
  createDiagnosticsSchema
} from '../../../packages/domains/diagnostics/src/server/schema'
import { LATEST_MIGRATION_VERSION } from '../../../packages/shared/db-migrations/src/index'
import { CHAT_STORAGE_SCHEMA_VERSION } from '../../../packages/domains/chat-runtime/src/server/storage'

// ---------------------------------------------------------------------------- types

interface Topology {
  desktop: boolean
  /** Computer names that must end up connected to the desktop hub. */
  desktopComputers?: string[]
  hubs: Array<{ name: string; root: string; env: Record<string, string>; computers: string[] }>
  /** Standalone computers. `env` = what the user keeps passing on every start (the hub
   *  address); the single-use join token is NOT replayed, the stored credential is used. */
  computers: Array<{ name: string; root: string; env?: Record<string, string> }>
}
interface Persona {
  release: string
  summary: string
  topology: Topology
}

const REPO = process.env.SLZ_REPO ?? '/repo'
const HUB_BIN = join(REPO, 'packages/apps/hub/dist/bin.cjs')
const COMPUTER_BIN = join(REPO, 'packages/apps/computer/dist/bin.cjs')
const HOOKS_SRC = join(REPO, 'packages/shared/hooks/src')

const [personaPath, inputTar, outDir] = process.argv.slice(2)
if (!personaPath || !inputTar || !outDir) {
  console.error('usage: harness.cjs <persona.json> <input.tar.gz> <out dir>')
  process.exit(64)
}
const persona = JSON.parse(readFileSync(personaPath, 'utf8')) as Persona
const HOME = homedir()
const REF = '/tmp/persona-input-ref'
const logsDir = join(outDir, 'logs')
mkdirSync(logsDir, { recursive: true })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (msg: string) => console.log(`[harness ${new Date().toISOString().slice(11, 19)}] ${msg}`)

// ------------------------------------------------------------------- 1. unpack input

function unpack(): void {
  mkdirSync(REF, { recursive: true })
  execFileSync('tar', ['-xzf', inputTar, '-C', HOME])
  execFileSync('tar', ['-xzf', inputTar, '-C', REF])
}

// ------------------------------------------------------------ 2. desktop boot replay

const desktopHubPort = SIDECAR_FIXED_PORT.prod

async function replayDesktopFilePasses(): Promise<{ hubRoot: string; computerRoot: string }> {
  // A packaged stable build: no `-` in the version → channel `stable` (index.ts:349).
  process.env.SLAYZONE_RELEASE_CHANNEL = 'stable'
  delete process.env.SLAYZONE_ROOT
  delete process.env.SLAYZONE_DEV

  // index.ts:272 — Linux XDG move, then userData = the XDG state dir.
  let userData = join(HOME, '.config', 'SlayZone') // Electron's default; replaced below on success
  const xdg = migrateXdgIfNeeded()
  if (!xdg.failed) {
    userData = getStateDir()
    mkdirSync(userData, { recursive: true })
  }
  log(`desktop: xdg ${JSON.stringify(xdg)} userData=${userData}`)

  // index.ts:311 + 379 — legacy state = userData before any profile swap (packaged:
  // none); the packaged app holds the single-instance lock.
  const legacyStateDir = resolveLegacyStateDir(userData, { isPlaywright: false, sandboxDir: undefined })
  const hubRoot = initStorageDir(legacyStateDir, true, true)
  const computerRoot = getSupervisedRoot('computer')
  log(`desktop: initStorageDir → ${hubRoot}`)

  // whenReady: diagnostics worker (app/src/main/db/diag-worker.ts).
  const diagPath = join(hubRoot, getDiagnosticsDbName(true))
  selfHealDiagnosticsDb(diagPath)
  {
    const db = new Database(diagPath)
    applyDiagnosticsPragmas(db)
    createDiagnosticsSchema(db)
    db.close()
  }

  // index.ts:1977 — client-scoped settings out of the shared DB (BEFORE the hub runs).
  const cs = await migrateClientSettings({
    clientRoot: getClientRoot(),
    dbPath: join(hubRoot, getDbName(true))
  })
  log(`desktop: client settings ${JSON.stringify(cs)}`)

  // index.ts:2004 — v127 disk move.
  const v127 = migrateV127DiskDir(join(hubRoot, 'assets'), join(hubRoot, 'artifacts'))
  log(`desktop: v127 ${JSON.stringify(v127)}`)
  return { hubRoot, computerRoot }
}

/** index.ts:2991 — the boot-time agent-hook installers (after the hub is up). */
async function installAgentHooks(): Promise<void> {
  const { path: scriptPath } = await installNotifyScript({
    source: readFileSync(join(HOOKS_SRC, 'notify.sh'), 'utf8')
  })
  await installClaudeHooks({ scriptPath })
  await installCodexHooks({ scriptPath })
  await uninstallCodexWrapper()
  await installGeminiHooks({ scriptPath })
  await installAntigravityHooks({ scriptPath })
  await installOpencodePlugin({
    notifyPath: scriptPath,
    source: readFileSync(join(HOOKS_SRC, 'opencode-plugin.js'), 'utf8')
  })
}

// ------------------------------------------------------------------ 3. processes

interface Proc {
  label: string
  kind: 'hub' | 'computer'
  child: ChildProcess
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}
const procs: Proc[] = []

function start(label: string, kind: Proc['kind'], script: string, env: NodeJS.ProcessEnv, cwd: string): Proc {
  mkdirSync(cwd, { recursive: true })
  // stdin stays an open pipe: the hub reads EOF as "the app died" (platform/parent-watch).
  const child = spawn(process.execPath, [script], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = createWriteStream(join(logsDir, `${label}.log`))
  child.stdout?.pipe(out)
  child.stderr?.pipe(out)
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
    child.on('exit', (code, signal) => res({ code, signal }))
  )
  const p = { label, kind, child, exit }
  procs.push(p)
  log(`started ${label} (pid ${child.pid})`)
  return p
}

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('SLAYZONE_')) delete env[k]
  env.SLAYZONE_RELEASE_CHANNEL = 'stable'
  return env
}

async function waitHealth(port: number, label: string, ms = 180_000): Promise<void> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const dead = procs.find((p) => p.label === label && p.child.exitCode !== null)
    if (dead) throw new Error(`${label} exited with ${dead.child.exitCode} before /health answered`)
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)
    if (ok) return
    await sleep(500)
  }
  throw new Error(`${label}: /health on ${port} never answered`)
}

async function mintJoinToken(port: number, label: string): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/api/computers/join-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label })
  })
  const j = (await r.json()) as { token?: string }
  if (!j.token) throw new Error(`join-token mint on ${port} failed: ${JSON.stringify(j)}`)
  return j.token
}

async function connectedNames(port: number): Promise<string[]> {
  const r = await fetch(`http://127.0.0.1:${port}/api/computers`).catch(() => null)
  if (!r?.ok) return []
  const list = (await r.json()) as Array<{ name: string; connected: boolean }>
  return list.filter((c) => c.connected).map((c) => c.name)
}

function portOf(listen: string): number {
  return Number(listen.split(':').pop())
}

/** Every database file's (size, mtime) except diagnostics, which logs continuously. */
function dbFingerprint(): string {
  const parts: string[] = []
  for (const f of walk(HOME)) {
    if (!/\.sqlite(-wal)?$/.test(f) || /diagnostics/.test(f) || f.includes('/.local/state/')) continue
    const s = statSync(f)
    parts.push(`${f}:${s.size}:${s.mtimeMs}`)
  }
  return parts.sort().join('|')
}

async function waitSettled(expect: Array<{ port: number; names: string[] }>): Promise<string> {
  const deadline = Date.now() + 300_000
  for (;;) {
    const missing: string[] = []
    for (const e of expect) {
      const have = await connectedNames(e.port)
      for (const n of e.names) if (!have.includes(n)) missing.push(`${n}@${e.port}`)
    }
    if (missing.length === 0) break
    if (Date.now() > deadline) return `TIMEOUT: never connected: ${missing.join(', ')}`
    await sleep(1000)
  }
  log('all computers connected; waiting for the databases to go quiet')
  const startQuiet = Date.now()
  let last = dbFingerprint()
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    await sleep(1000)
    const now = dbFingerprint()
    if (now !== last) {
      last = now
      quietSince = Date.now()
    } else if (Date.now() - quietSince >= 10_000 && Date.now() - startQuiet >= 20_000) {
      return `settled after ${Math.round((Date.now() - startQuiet) / 1000)}s`
    }
  }
  return 'TIMEOUT: databases never went quiet'
}

async function stopAll(): Promise<string[]> {
  const problems: string[] = []
  for (const kind of ['computer', 'hub'] as const) {
    const group = procs.filter((p) => p.kind === kind && p.child.exitCode === null && p.child.signalCode === null)
    for (const p of group) p.child.kill('SIGTERM')
    for (const p of group) {
      const r = await Promise.race([p.exit, sleep(60_000).then(() => null)])
      if (!r) {
        p.child.kill('SIGKILL')
        problems.push(`${p.label}: did not exit within 60s of SIGTERM (killed)`)
      } else if (!(r.code === 0 || r.signal === 'SIGTERM' || r.code === 143)) {
        problems.push(`${p.label}: exited code=${r.code} signal=${r.signal}`)
      }
    }
  }
  for (const p of procs) {
    const r = p.child.exitCode
    if (r !== null && r !== 0 && r !== 143 && !problems.some((x) => x.startsWith(`${p.label}:`))) {
      problems.push(`${p.label}: exited early with code ${r}`)
    }
  }
  return problems
}

// --------------------------------------------------------------------- 4. dump

function* walk(dir: string): Generator<string> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile()) yield p
  }
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
/**
 * Random-looking tokens (ids, keys, hashes) — matched as candidate runs, then judged by
 * {@link isRandomToken}: 32+ lowercase hex, or 20+ base62/base64url chars with many
 * upper- AND lowercase letters (not a camelCase word). Readable ids like
 * `claude-opus-4-1-20250805` or `computerDataHandoff` are left alone.
 */
const TOKEN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g
function isRandomToken(t: string): boolean {
  if (/^[0-9a-f]{32,}$/.test(t)) return /\d/.test(t) && /[a-f]/.test(t)
  const upper = (t.match(/[A-Z]/g) ?? []).length
  const lower = (t.match(/[a-z]/g) ?? []).length
  return upper >= 6 && lower >= 6 && !/^[a-z]+([A-Z][a-z0-9]+)+$/.test(t)
}
const ISO_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g
const NUM_RE = /(?<![\d.])\d{10}(?:\d{3})?(?![\d.])/g

/**
 * Every value the INPUT already contains — UUIDs, random-looking tokens, timestamps.
 * Those are the persona's own data and are dumped verbatim; only values THIS run
 * created are normalized. (Without this, a persona generated minutes before a run would
 * have its own timestamps masked, and the golden output would depend on when it ran.)
 */
function collectInputValues(): Set<string> {
  const set = new Set<string>()
  const add = (s: string) => {
    for (const m of s.matchAll(UUID_RE)) set.add(m[0].toLowerCase())
    for (const m of s.matchAll(TOKEN_RE)) if (isRandomToken(m[0])) set.add(m[0])
    for (const re of [ISO_RE, NUM_RE]) for (const m of s.matchAll(re)) set.add(m[0])
  }
  for (const f of walk(REF)) {
    if (f.includes(`${sep}.git${sep}`)) continue
    add(relative(REF, f))
    if (/\.sqlite$/.test(f)) {
      const db = openReadonlyCopy(f)
      if (!db) continue
      for (const t of tables(db)) {
        for (const row of db.prepare(`SELECT * FROM "${t}"`).raw().all() as unknown[][]) add(JSON.stringify(row))
      }
      db.close()
    } else if (statSync(f).size < 4_000_000) {
      add(readFileSync(f, 'latin1'))
    }
  }
  return set
}

/** Read a DB without ever writing next to it: copy the triplet to a temp dir first. */
function openReadonlyCopy(file: string): Database.Database | null {
  const tmp = join('/tmp/ro', createHash('sha1').update(file).digest('hex'))
  mkdirSync(tmp, { recursive: true })
  for (const suf of ['', '-wal', '-shm']) {
    if (existsSync(file + suf)) writeFileSync(join(tmp, `db.sqlite${suf}`), readFileSync(file + suf))
  }
  try {
    return new Database(join(tmp, 'db.sqlite'))
  } catch {
    return null
  }
}

function tables(db: Database.Database): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name)
}

let runStartMs = 0
let inputValues = new Set<string>()

/** Created by this run: from just before it started, up to a year ahead (expiries). */
function inWindow(ms: number): boolean {
  return ms >= runStartMs - 120_000 && ms <= runStartMs + 400 * 86_400_000
}

/** Replace values minted by THIS run (ids, keys, wall-clock times) with stable tokens. */
function normalize(s: string): string {
  const known = (v: string) => inputValues.has(v) || inputValues.has(v.toLowerCase())
  return (
    s
      .replace(UUID_RE, (u) => (known(u) ? u : '<new-uuid>'))
      // API keys the hub mints for computers, and their 6-char `start` echo.
      .replace(/\bszr_[A-Za-z0-9_-]+/g, (k) => (known(k) ? k : 'szr_<new-key>'))
      .replace(TOKEN_RE, (t) => (!isRandomToken(t) || known(t) ? t : '<new-token>'))
      .replace(ISO_RE, (d) => {
        if (known(d)) return d
        const iso = d.includes('T') ? d : `${d.replace(' ', 'T')}Z`
        const ms = Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`)
        return Number.isFinite(ms) && inWindow(ms) ? '<run-time>' : d
      })
      // File-name form of an ISO time (backups): 2026-11-10T14-21-33-888Z.
      .replace(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/g, (d, day, h, m, sec, ms) => {
        const t = Date.parse(`${day}T${h}:${m}:${sec}.${ms}Z`)
        return Number.isFinite(t) && inWindow(t) ? '<run-time>' : d
      })
      .replace(NUM_RE, (n) => {
        if (known(n)) return n
        const ms = n.length === 13 ? Number(n) : Number(n) * 1000
        return inWindow(ms) ? (n.length === 13 ? '<run-ms>' : '<run-s>') : n
      })
  )
}

/** Tables that are a runtime log of THIS boot, not migrated data: schema only. */
const RUNTIME_LOG_TABLES = new Set(['diagnostics_events'])

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])
    )
  }
  return v
}

function cell(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return { $blob: createHash('sha256').update(v).digest('hex'), bytes: v.length }
  return v
}

function dumpDb(file: string): string {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  const lines: string[] = []
  lines.push(`user_version ${db.pragma('user_version', { simple: true })}`)
  lines.push('', '## schema')
  const schema = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all() as Array<{ type: string; name: string; sql: string | null }>
  for (const r of schema) lines.push(`${r.type} ${r.name}: ${(r.sql ?? '').replace(/\s+/g, ' ').trim()}`)
  for (const t of tables(db)) {
    if (RUNTIME_LOG_TABLES.has(t)) {
      lines.push('', `## ${t} (runtime log of this boot — rows not compared)`)
      continue
    }
    const rows = (db.prepare(`SELECT * FROM "${t}"`).all() as Array<Record<string, unknown>>).map((r) =>
      normalize(JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)]))))
    )
    rows.sort()
    lines.push('', `## ${t} (${rows.length})`, ...rows)
  }
  db.close()
  return `${lines.join('\n')}\n`
}

const SKIP_DIRS = new Set(['logs', 'request-log', '.git'])

function isSkipped(rel: string): boolean {
  const parts = rel.split(sep)
  if (parts[0] === 'repos') return true // the user's own git repos; no migration touches them
  if (parts.some((p) => SKIP_DIRS.has(p))) return true
  return /\.log$/.test(rel) || /\.sqlite-(wal|shm|journal)$/.test(rel)
}

function dumpAll(): void {
  const fileLines: string[] = []
  for (const f of [...walk(HOME)].sort()) {
    const rel = relative(HOME, f)
    if (isSkipped(rel)) continue
    const relN = normalize(rel)
    if (/\.sqlite$/.test(rel)) {
      if (rel.split(sep).includes('backups')) {
        fileLines.push(`${relN}  (database backup)`)
        continue
      }
      const target = join(outDir, 'db', `${rel}.txt`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, dumpDb(f))
      fileLines.push(`${relN}  (database → db/${rel}.txt)`)
      continue
    }
    const buf = readFileSync(f)
    if (/\.json$/.test(rel)) {
      try {
        const json = JSON.stringify(sortKeys(JSON.parse(buf.toString('utf8'))), null, 2)
        fileLines.push(`${relN}  (json)`, ...normalize(json).split('\n').map((l) => `    ${l}`))
        continue
      } catch {
        /* not JSON after all — hash it */
      }
    }
    const text = buf.length <= 65_536 && !buf.includes(0) ? buf.toString('utf8') : null
    if (text !== null && Buffer.from(text, 'utf8').equals(buf)) {
      fileLines.push(`${relN}  (text)`, ...normalize(text.replace(/\n$/, '')).split('\n').map((l) => `    ${l}`))
      continue
    }
    fileLines.push(`${relN}  sha256=${createHash('sha256').update(buf).digest('hex').slice(0, 16)} bytes=${buf.length}`)
  }
  writeFileSync(join(outDir, 'files.txt'), `${fileLines.join('\n')}\n`)
}

// -------------------------------------------------------------- 5. invariants

const CORE_TABLES = ['projects', 'tasks', 'tags', 'task_tags', 'task_templates', 'task_artifacts', 'automations']

function count(db: Database.Database, t: string): number | null {
  return tables(db).includes(t) ? (db.prepare(`SELECT count(*) AS c FROM "${t}"`).get() as { c: number }).c : null
}

/** Where a hub's database was in the INPUT, for each hub database in the output. */
function inputHubDb(outHubDb: string): string | null {
  const rel = relative(HOME, outHubDb)
  const root = dirname(rel)
  const candidates =
    root === '.slayzone/stable/hub'
      ? [
          `${root}/slayzone.data.sqlite`,
          `${root}/slayzone.sqlite`,
          '.slayzone/storage/slayzone.sqlite',
          '.local/state/slayzone/slayzone.sqlite',
          '.config/slayzone/slayzone.sqlite'
        ]
      : [`${root}/slayzone.data.sqlite`, `${root}/slayzone.sqlite`]
  for (const c of candidates) if (existsSync(join(REF, c))) return join(REF, c)
  return null
}

function checkInvariants(processProblems: string[], settle: string[]): string[] {
  const out: string[] = []
  const fail = (m: string) => out.push(`FAIL ${m}`)
  const pass = (m: string) => out.push(`ok   ${m}`)

  for (const p of processProblems) fail(`process: ${p}`)
  for (const s of settle) (s.startsWith('TIMEOUT') ? fail : pass)(`settle: ${s}`)

  for (const f of [...walk(HOME)].sort()) {
    const rel = relative(HOME, f)
    if (!/\.sqlite$/.test(rel) || isSkipped(rel) || rel.split(sep).includes('backups')) continue
    if (rel.startsWith('.local/state/')) continue // the legacy source copy, read-only by design
    const db = new Database(f, { readonly: true, fileMustExist: true })
    const integrity = db.pragma('integrity_check', { simple: true })
    ;(integrity === 'ok' ? pass : fail)(`${rel}: integrity_check ${integrity}`)
    const fk = db.prepare('PRAGMA foreign_key_check').all().length
    ;(fk === 0 ? pass : fail)(`${rel}: foreign_key_check ${fk} violation(s)`)
    const uv = db.pragma('user_version', { simple: true }) as number

    if (rel.endsWith('slayzone.data.sqlite')) {
      ;(uv === LATEST_MIGRATION_VERSION ? pass : fail)(`${rel}: user_version ${uv} (latest ${LATEST_MIGRATION_VERSION})`)
      const src = inputHubDb(f)
      const ref = src ? openReadonlyCopy(src) : null
      if (ref) {
        for (const t of CORE_TABLES) {
          const before = count(ref, t)
          if (!before) continue
          const after = count(db, t)
          ;(after !== null && after >= before ? pass : fail)(`${rel}: ${t} rows ${before} → ${after ?? 'table gone'}`)
        }
        // Every project that had a folder before the upgrade must still have one.
        const legacy = tables(ref).includes('projects')
          ? (ref
              .prepare("SELECT id, name, path FROM projects WHERE path IS NOT NULL AND path <> ''")
              .all() as Array<{ id: string; name: string; path: string }>)
          : []
        for (const p of legacy) {
          const ready = db
            .prepare(
              `SELECT c.name FROM project_placements pp JOIN computers c ON c.id = pp.computer_id
                WHERE pp.project_id = ? AND pp.status = 'ready'`
            )
            .all(p.id) as Array<{ name: string }>
          ;(ready.length > 0 ? pass : fail)(
            `${rel}: project "${p.name}" (folder ${p.path}) has a ready folder on ${
              ready.length ? ready.map((r) => r.name).join(', ') : 'NO computer'
            }`
          )
          // Before the per-computer folder split, ONE path served whichever computer ran
          // the work. So every computer the user bound this project's work to — the
          // project's default computer, and any computer a task was pinned to — must
          // still have the folder, or that work silently loses its working directory.
          const bound = db
            .prepare(
              `SELECT DISTINCT c.id, c.name, x.why FROM (
                 SELECT default_computer_id AS cid, 'project default' AS why FROM projects WHERE id = ?
                 UNION SELECT computer_id, 'task "' || title || '" pinned' FROM tasks WHERE project_id = ?
               ) x JOIN computers c ON c.id = x.cid`
            )
            .all(p.id, p.id) as Array<{ id: string; name: string; why: string }>
          for (const b of bound) {
            const has = db
              .prepare(
                "SELECT 1 FROM project_placements WHERE project_id = ? AND computer_id = ? AND status = 'ready'"
              )
              .get(p.id, b.id)
            ;(has ? pass : fail)(
              `${rel}: project "${p.name}" folder is ready on ${b.name} (${b.why} there)`
            )
          }
        }
        ref.close()
      } else {
        out.push(`note ${rel}: no input database found to compare with`)
      }
      if (tables(db).includes('project_placements')) {
        const stuck = db
          .prepare(
            `SELECT pp.computer_id, pp.project_id, pp.status, (c.id IS NOT NULL) AS known
               FROM project_placements pp LEFT JOIN computers c ON c.id = pp.computer_id
              WHERE pp.status <> 'ready' OR c.id IS NULL`
          )
          .all() as Array<{ computer_id: string; project_id: string; status: string; known: number }>
        if (stuck.length === 0) pass(`${rel}: every project folder is ready on a registered computer`)
        for (const s of stuck) {
          // A row for a computer this hub has never seen is unreachable, not lost data:
          // v176 stages the local computer's folder before it ever enrolls (a desktop that
          // skipped releases), so a migration cannot tell that apart from a standalone hub
          // and must keep it. The checks above decide whether every bound computer has
          // its folder.
          ;(s.known ? fail : (m: string) => out.push(`note ${m}`))(
            `${rel}: project ${s.project_id} folder is '${s.status}' on computer ${s.computer_id}${
              s.known ? '' : ' (not registered on this hub — unreachable, kept)'
            }`
          )
        }
      }
      const handoff = count(db, 'computer_data_handoff')
      if (handoff !== null) ((handoff === 0 ? pass : fail) as (m: string) => void)(`${rel}: computer_data_handoff rows left ${handoff}`)
    } else if (/(^|\/)chat\.sqlite$/.test(rel)) {
      ;(uv === CHAT_STORAGE_SCHEMA_VERSION ? pass : fail)(
        `${rel}: user_version ${uv} (latest ${CHAT_STORAGE_SCHEMA_VERSION})`
      )
    }
    db.close()
  }
  return out
}

// --------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const topo = persona.topology
  log(`persona ${persona.release}: ${persona.summary}`)
  unpack()
  inputValues = collectInputValues()
  runStartMs = Date.now()

  const expect: Array<{ port: number; names: string[] }> = []
  if (topo.desktop) {
    const { hubRoot, computerRoot } = await replayDesktopFilePasses()
    // sidecar-server-supervisor.ts:486 — hub-clean env + the supervised values.
    const hubEnv = baseEnv()
    for (const k of HUB_PROCESS_ENV) delete hubEnv[k]
    Object.assign(hubEnv, {
      SLAYZONE_ROOT: hubRoot,
      SLAYZONE_SUPERVISED: '1',
      SLAYZONE_HUB_LISTEN_ADDRESS: `127.0.0.1:${desktopHubPort}`,
      SLAYZONE_HUB_REQUIRE_LOGIN: '0'
    })
    start('desktop-hub', 'hub', HUB_BIN, hubEnv, hubRoot)
    await waitHealth(desktopHubPort, 'desktop-hub')
    // index.ts:986 — the co-located local computer, freshly minted token every boot.
    const token = await mintJoinToken(desktopHubPort, 'local-computer')
    start(
      'desktop-computer',
      'computer',
      COMPUTER_BIN,
      {
        ...baseEnv(),
        SLAYZONE_ROOT: computerRoot,
        SLAYZONE_SUPERVISED: '1',
        SLAYZONE_HUB_ADDRESS: `127.0.0.1:${desktopHubPort}`,
        SLAYZONE_HUB_JOIN_TOKEN: token
      },
      computerRoot
    )
    await installAgentHooks()
    expect.push({ port: desktopHubPort, names: topo.desktopComputers ?? ['local-computer'] })
  }
  for (const h of topo.hubs) {
    const root = join(HOME, h.root)
    start(`hub-${h.name}`, 'hub', HUB_BIN, { ...baseEnv(), SLAYZONE_ROOT: root, SLAYZONE_NONINTERACTIVE: '1', ...h.env }, root)
    await waitHealth(portOf(h.env.SLAYZONE_HUB_LISTEN_ADDRESS), `hub-${h.name}`)
    expect.push({ port: portOf(h.env.SLAYZONE_HUB_LISTEN_ADDRESS), names: h.computers })
  }
  for (const c of topo.computers) {
    const root = join(HOME, c.root)
    start(`computer-${c.root.replace(/\W+/g, '-')}`, 'computer', COMPUTER_BIN, { ...baseEnv(), SLAYZONE_ROOT: root, SLAYZONE_NONINTERACTIVE: '1', ...c.env }, root)
  }

  const settle = await waitSettled(expect).catch((e: Error) => `TIMEOUT: ${e.message}`)
  log(`settle: ${settle}`)
  const problems = await stopAll()
  log('stopped; dumping')

  dumpAll()
  const inv = checkInvariants(problems, [settle])
  writeFileSync(join(outDir, 'invariants.txt'), `${inv.join('\n')}\n`)
  const failed = inv.filter((l) => l.startsWith('FAIL'))
  for (const l of inv) console.log(l)
  log(failed.length ? `${failed.length} invariant(s) FAILED` : 'all invariants hold')
  process.exit(failed.length ? 2 : 0)
}

main().catch(async (err) => {
  console.error('[harness] fatal:', err)
  await stopAll().catch(() => [])
  process.exit(1)
})
