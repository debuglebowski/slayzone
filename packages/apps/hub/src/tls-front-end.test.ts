/**
 * A hub behind a TLS front end, reached with NO certificate pin — end to end.
 *
 * The hub never terminates TLS. A front end does (an Application Gateway, a reverse
 * proxy) with a certificate from a CA, and every client verifies it the normal way:
 * CA chain + hostname, nothing pinned, nothing relaxed. This boots the BUILT hub on
 * loopback (login on, a public address set — the reachable shape) behind a real TLS
 * front end in this process (Node https + raw upgrade forwarding), with a leaf issued
 * by a throwaway test CA, and proves:
 *
 *   - the CLI (`slay`, built, plain node) mints a join token and lists projects over
 *     https, trusting the CA via `NODE_EXTRA_CA_CERTS` — and refuses without it;
 *   - a computer (built bin, its own process, same `NODE_EXTRA_CA_CERTS`) enrolls over
 *     `wss://`, and a tRPC websocket client in this process (CA added to Node's default
 *     store) sees it connected;
 *   - swapping the front end's certificate (new leaf, same CA) and dropping every
 *     connection loses nothing: the computer reconnects with its stored credentials
 *     (`hello`, same id, one row, credentials file untouched);
 *   - a join token minted by an OLDER hub, carrying a certificate pin, still enrolls:
 *     the pin is ignored, the front end is CA-verified, and the computer says so;
 *   - the hub created no `identity/` directory.
 *
 * The test CA is trusted only through the normal CA path (`NODE_EXTRA_CA_CERTS` for
 * child processes, `tls.setDefaultCACertificates` here) — no product code has a switch
 * that skips verification. The front end is `localhost`, so the token the hub mints
 * says `ws://` (a loopback public address is plaintext by rule A1); the computer is
 * pointed at the front end's `wss://` url through computer.config.json, the same
 * explicit override an operator has.
 *
 * ISOLATION: every child gets a throwaway SLAYZONE_ROOT and HOME (the CLI's target file
 * and the computer's agent hooks live under HOME), every inherited SLAYZONE_/ELECTRON_
 * var is scrubbed, and all ports are OS-assigned.
 *
 * Native ABI: hub (better-sqlite3) and computer (node-pty) bundles run under
 * `ELECTRON_RUN_AS_NODE=1 electron`, and so does this test (run_test_electron_strict_
 * loader). Needs the `openssl` CLI for the test CA. Bundles are (re)built on demand.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
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
import { request as httpRequest } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createRequire } from 'node:module'
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'
import { deriveBootstrapOwnerPassword } from '@slayzone/platform/hub-auth-secret'
import { BOOTSTRAP_OWNER_EMAIL } from '@slayzone/platform/hub-owner-file'
import { createTestCa, trustTestCaInThisProcess, type TestLeaf } from '@slayzone/test-utils/test-ca'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const HUB_DIR = join(__dirname, '..') // packages/apps/hub
const PACKAGES = join(HUB_DIR, '..', '..') // packages/
const COMPUTER_DIR = join(PACKAGES, 'apps', 'computer')
const CLI_DIR = join(PACKAGES, 'apps', 'cli')
const HUB_BIN = join(HUB_DIR, 'dist', 'bin.cjs')
const COMPUTER_BIN = join(COMPUTER_DIR, 'dist', 'bin.cjs')
const CLI_BIN = join(CLI_DIR, 'dist', 'slay.js')
const ELECTRON_BIN = require('electron') as unknown as string
// The CLI is plain node (no native deps) — what a user runs. NOT process.execPath:
// that is Electron here, and without ELECTRON_RUN_AS_NODE it would open a window.
const NODE_BIN = process.env.SLZ_TEST_NODE ?? 'node'

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

/** Newest mtime under a dir tree (for stale-build detection). */
function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs)
  }
  return newest
}

/** (Re)build a bundle when it is missing or older than any of the sources it bundles
 *  that this test depends on — the token codec and the dialer live outside the app. */
function ensureBuilt(pkgDir: string, bin: string, label: string, srcDirs: string[]): void {
  let needs = !existsSync(bin)
  if (!needs) {
    const built = statSync(bin).mtimeMs
    needs = srcDirs.some((d) => newestMtime(d) > built)
  }
  if (!needs) return
  console.log(`  … building ${label} bundle (bin missing or stale)`)
  execFileSync('node', ['build.mjs'], { cwd: pkgDir, stdio: 'inherit' })
  if (!existsSync(bin)) throw new Error(`${label} build did not produce ${bin}`)
}

/** Inherited env minus every SLAYZONE_/ELECTRON_ key (and any CA override). */
function scrubbedEnv(home: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (/^(SLAYZONE_|ELECTRON_)/.test(k) || k === 'NODE_EXTRA_CA_CERTS') continue
    out[k] = v
  }
  out.HOME = home
  return out
}

interface Proc {
  proc: ChildProcess
  logs: string[]
  stop: () => Promise<void>
}

function spawnElectronChild(bin: string, env: Record<string, string>): Proc {
  const logs: string[] = []
  // stdin is a held-open PIPE: a hub treats stdin EOF as "my parent died".
  const proc = spawn(ELECTRON_BIN, [bin], {
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const cap = (b: Buffer): void => {
    for (const line of b.toString().split('\n')) if (line.trim()) logs.push(line)
  }
  proc.stdout?.on('data', cap)
  proc.stderr?.on('data', cap)
  return {
    proc,
    logs,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
        const t = setTimeout(() => proc.kill('SIGKILL'), 3_000)
        proc.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
        proc.kill('SIGTERM')
      })
  }
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

interface FrontEnd {
  port: number
  /** Serve a different certificate for every NEW handshake. */
  swapCert: (leaf: TestLeaf) => void
  /** Destroy every open client connection (and its upstream). */
  dropAll: () => void
  close: () => Promise<void>
}

/**
 * The TLS front end: terminates TLS with `leaf`, forwards plain http and websocket
 * upgrades to the hub's loopback listener — what an Application Gateway does, minus
 * everything the hub does not depend on. Started before the hub (its port is the
 * hub's public address); `upstream` is read per request.
 */
async function startFrontEnd(leaf: TestLeaf, upstream: { port: number }): Promise<FrontEnd> {
  const sockets = new Set<Socket>()
  const server: HttpsServer = createHttpsServer(
    { cert: leaf.certPem, key: leaf.keyPem },
    (req, res) => {
      const up = httpRequest(
        {
          host: '127.0.0.1',
          port: upstream.port,
          method: req.method,
          path: req.url,
          headers: req.headers
        },
        (ur) => {
          res.writeHead(ur.statusCode ?? 502, ur.headers)
          ur.pipe(res)
        }
      )
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      req.pipe(up)
    }
  )
  server.on('secureConnection', (s: Socket) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('upgrade', (req, socket: Socket, head: Buffer) => {
    const up = netConnect(upstream.port, '127.0.0.1', () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
      }
      up.write(`${raw}\r\n`)
      if (head.length > 0) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    const kill = (): void => {
      up.destroy()
      socket.destroy()
    }
    up.on('error', kill)
    up.on('close', kill)
    socket.on('error', kill)
    socket.on('close', kill)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: (server.address() as AddressInfo).port,
    swapCert: (next) => server.setSecureContext({ cert: next.certPem, key: next.keyPem }),
    dropAll: () => {
      for (const s of sockets) s.destroy()
    },
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }
}

/** sha256 of the leaf the front end serves to a NEW, normally verified connection. */
function servedLeafSha256(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ host: 'localhost', port, servername: 'localhost' }, () => {
      const cert = s.getPeerCertificate()
      s.end()
      resolve(createHash('sha256').update(cert.raw).digest('hex'))
    })
    s.on('error', reject)
  })
}

function leafSha256(leaf: TestLeaf): string {
  return createHash('sha256').update(new X509Certificate(leaf.certPem).raw).digest('hex')
}

/**
 * Run the built `slay` with an isolated HOME (its hub-target file lives there).
 * ASYNC on purpose: the front end runs in THIS process, so a spawnSync would stall
 * its event loop and every handshake with it.
 */
function slay(
  args: string[],
  home: string,
  extraEnv: Record<string, string> = {}
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE_BIN, [CLI_BIN, ...args], {
      env: { ...scrubbedEnv(home), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (b: Buffer) => (stdout += b.toString()))
    proc.stderr.on('data', (b: Buffer) => (stderr += b.toString()))
    // Never hang the suite: a wedged CLI call fails the case instead.
    const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000)
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`slay ${args.join(' ')} failed to run: ${err.message}`))
    })
    proc.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

/** A token in the shape an OLDER hub minted: with a pin of its own certificate. */
function legacyPinnedToken(hubUrl: string): string {
  const payload = {
    hubUrl,
    certFingerprint: randomBytes(32).toString('hex'),
    secret: randomBytes(32).toString('base64url')
  }
  return `szjt1.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

async function main(): Promise<void> {
  console.log('\nhub behind a TLS front end — CA-verified, no pin')
  console.log('─'.repeat(52))

  const platformSrc = join(PACKAGES, 'shared', 'platform', 'src')
  ensureBuilt(HUB_DIR, HUB_BIN, 'hub', [
    join(HUB_DIR, 'src'),
    platformSrc,
    join(PACKAGES, 'domains', 'computers', 'src'),
    join(PACKAGES, 'domains', 'computer-transport', 'src'),
    join(PACKAGES, 'shared', 'transport', 'src')
  ])
  ensureBuilt(COMPUTER_DIR, COMPUTER_BIN, 'computer', [
    join(COMPUTER_DIR, 'src'),
    platformSrc,
    join(PACKAGES, 'domains', 'computer-transport', 'src')
  ])
  ensureBuilt(CLI_DIR, CLI_BIN, 'cli', [join(CLI_DIR, 'src'), platformSrc])

  const root = mkdtempSync(join(tmpdir(), 'slz-tls-front-end-'))
  const hubRoot = join(root, 'hub-root')
  const computerRoot = join(root, 'computer-root')
  const legacyRoot = join(root, 'legacy-computer-root')
  const workDir = join(root, 'work')
  const home = join(root, 'home')
  for (const d of [hubRoot, computerRoot, legacyRoot, workDir, home]) {
    mkdirSync(d, { recursive: true })
  }

  const ca = createTestCa()
  const leafA = ca.issueLeaf()
  const leafB = ca.issueLeaf()
  // This process's own clients (fetch, tRPC websocket, the served-leaf probe) trust
  // the CA through Node's default store — the in-process NODE_EXTRA_CA_CERTS.
  const restoreCa = trustTestCaInThisProcess(ca.caPem)
  const childCa = { NODE_EXTRA_CA_CERTS: ca.caPath }

  const upstream = { port: 0 }
  const front = await startFrontEnd(leafA, upstream)
  const publicHost = `localhost:${front.port}`
  const wssComputers = `wss://${publicHost}/computers`

  let hub: Proc | null = null
  let computer: Proc | null = null
  let legacy: Proc | null = null
  const wsClients: Array<{ close: () => void }> = []
  const { createTRPCClient, createWSClient, wsLink } = await import('@trpc/client')
  const superjson = (await import('superjson')).default
  type ComputerRow = { id: string; name: string; connected: boolean }
  const trpcOverFrontEnd = (token: string) => {
    const client = createWSClient({
      url: `wss://${publicHost}/trpc`,
      connectionParams: () => ({ token })
    })
    wsClients.push(client)
    return createTRPCClient({
      links: [wsLink({ client, transformer: superjson })]
    }) as unknown as { computers: { list: { query: () => Promise<ComputerRow[]> } } }
  }

  const hubSecret = randomBytes(32).toString('hex')
  try {
    hub = spawnElectronChild(HUB_BIN, {
      ...scrubbedEnv(home),
      SLAYZONE_ROOT: hubRoot,
      SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
      SLAYZONE_HUB_PUBLIC_ADDRESS: publicHost,
      SLAYZONE_HUB_REQUIRE_LOGIN: '1',
      SLAYZONE_HUB_AUTH_SECRET: hubSecret
    })
    const listen = await poll(
      async () => hub!.logs.find((l) => l.includes('listening on http://')) ?? null,
      40_000,
      'hub listening line'
    )
    const m = listen.match(/http:\/\/127\.0\.0\.1:(\d+).*db=([^)\s]+)/)
    assert(m, `hub listening line parseable: ${listen}`)
    upstream.port = Number(m[1])
    const hubDbPath = m[2]!
    // A reachable hub keeps no owner file (T-11): the owner's password derives from the
    // secret, and it signs in like any client.
    assert(!existsSync(join(hubRoot, 'hub.owner.json')), 'no hub.owner.json on a reachable hub')
    const ownerSignIn = await poll(
      async () => {
        const r = await fetch(`http://127.0.0.1:${upstream.port}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: hubUrlFromAddr(publicHost, 'http')
          },
          body: JSON.stringify({
            email: BOOTSTRAP_OWNER_EMAIL,
            password: deriveBootstrapOwnerPassword(hubSecret)
          })
        })
        return r.ok ? r : null
      },
      20_000,
      'bootstrap owner sign-in'
    )
    const ownerToken = ownerSignIn.headers.get('set-auth-token')
    assert(ownerToken, 'bootstrap owner token present')

    await test('the hub serves plain http and created no identity/ directory', async () => {
      const health = await poll(
        async () => {
          const r = await fetch(`http://127.0.0.1:${upstream.port}/health`)
          return r.status === 200 ? r : null
        },
        15_000,
        'hub /health'
      )
      assert(health.status === 200, 'plain http on the hub port')
      assert(!existsSync(join(hubRoot, 'identity')), 'no identity/ directory: the hub has no cert')
    })

    await test('https through the front end verifies against the CA (no override)', async () => {
      const r = await fetch(`https://${publicHost}/health`)
      assert(r.status === 200, `front end /health → 200, got ${r.status}`)
      assert(
        (await servedLeafSha256(front.port)) === leafSha256(leafA),
        'the front end serves leaf A'
      )
    })

    // The CLI reaches the hub the way an operator's laptop would: a saved https
    // target (what `slay hub login https://…` writes) and the CA in NODE_EXTRA_CA_CERTS.
    mkdirSync(join(home, '.slayzone', 'cli'), { recursive: true })
    writeFileSync(
      join(home, '.slayzone', 'cli', 'hub-target.json'),
      JSON.stringify({ url: `https://${publicHost}`, token: ownerToken })
    )

    await test('the CLI refuses the front end when its CA is not trusted', async () => {
      // Exit 1 is the CLI's own connect-failure exit (a hang would be a kill, not 1);
      // the identical call with the CA trusted succeeds below, so the CA is the cause.
      const res = await slay(['projects', 'list', '--json'], home)
      assert(
        res.status === 1,
        `untrusted CA must fail with exit 1, got ${res.status}: ${res.stdout}`
      )
      assert(
        /could not connect/i.test(res.stderr),
        `connect failure reported: ${res.stderr.trim()}`
      )
    })

    let token = ''
    await test('the CLI mints a join token over https with the CA trusted the normal way', async () => {
      const res = await slay(
        ['computer', 'mint', 'tls-front-end', '--json', '--for', BOOTSTRAP_OWNER_EMAIL],
        home,
        childCa
      )
      assert(res.status === 0, `mint exit 0, got ${res.status}: ${res.stderr.trim()}`)
      const minted = JSON.parse(res.stdout) as { token: string; hubUrl: string }
      token = minted.token
      const payload = JSON.parse(
        Buffer.from(token.slice('szjt1.'.length), 'base64url').toString('utf8')
      ) as Record<string, unknown>
      assert(!('certFingerprint' in payload), 'the token carries no certificate pin')
      // The public address is loopback, so the token says ws:// (rule A1) — the
      // computer below is pointed at the front end's wss:// url explicitly.
      assert(minted.hubUrl === `ws://${publicHost}/computers`, `token url: ${minted.hubUrl}`)
    })

    writeFileSync(
      join(computerRoot, 'computer.config.json'),
      JSON.stringify({
        computerName: 'tls-front-end-computer',
        allowedRoots: [workDir],
        hubUrl: wssComputers
      })
    )
    computer = spawnElectronChild(COMPUTER_BIN, {
      ...scrubbedEnv(home),
      ...childCa,
      SLAYZONE_ROOT: computerRoot,
      SLAYZONE_HUB_JOIN_TOKEN: token
    })

    const trpc = trpcOverFrontEnd(ownerToken)
    let computerId = ''
    await test('the computer enrolls over wss:// through the front end, with no pin', async () => {
      const row = await poll(
        async () => {
          const r = (await trpc.computers.list.query()).find(
            (x) => x.name === 'tls-front-end-computer'
          )
          return r?.connected ? r : null
        },
        30_000,
        `computer connected (computer logs:\n${computer!.logs.join('\n')})`
      )
      computerId = row.id
      assert(
        computer!.logs.some((l) => l.includes('connected to hub') && l.includes('"mode":"enroll"')),
        'computer logged an enroll'
      )
      assert(
        !computer!.logs.some((l) => l.includes('ignoring the certificate pin')),
        'a current token carries nothing to ignore'
      )
    })

    await test('a new front-end certificate (same CA) drops nothing on reconnect', async () => {
      const credsPath = join(computerRoot, 'computer.state.json')
      const credsBefore = readFileSync(credsPath, 'utf8')
      front.swapCert(leafB)
      front.dropAll()
      assert(
        (await servedLeafSha256(front.port)) === leafSha256(leafB),
        'the front end now serves leaf B'
      )
      const fresh = trpcOverFrontEnd(ownerToken)
      const row = await poll(
        async () => {
          const hello = (l: string) =>
            l.includes('connected to hub') && l.includes('"mode":"hello"')
          if (!computer!.logs.some(hello)) return null
          const r = (await fresh.computers.list.query()).find((x) => x.id === computerId)
          return r?.connected ? r : null
        },
        30_000,
        `computer reconnected (computer logs:\n${computer!.logs.join('\n')})`
      )
      assert(row.id === computerId, 'same computer id')
      const rows = (await fresh.computers.list.query()).filter(
        (x) => x.name === 'tls-front-end-computer'
      )
      assert(rows.length === 1, `still one row, got ${rows.length}`)
      assert(readFileSync(credsPath, 'utf8') === credsBefore, 'stored credentials untouched')
      assert(
        computer!.logs.filter(
          (l) => l.includes('connected to hub') && l.includes('"mode":"enroll"')
        ).length === 1,
        `reconnected with hello, never re-enrolled:\n${computer!.logs.join('\n')}`
      )
    })

    await test('the CLI keeps working against the new certificate', async () => {
      const res = await slay(['projects', 'list', '--json'], home, childCa)
      assert(res.status === 0, `projects list exit 0, got ${res.status}: ${res.stderr.trim()}`)
      assert(Array.isArray(JSON.parse(res.stdout)), 'a JSON array of projects')
    })

    await test('a join token from an OLDER hub (with a pin) still enrolls; the pin is ignored', async () => {
      // What an upgrade leaves behind: an unused token an older hub minted, its hash in
      // join_tokens. Written straight into the hub's database, as that hub would have.
      const legacyToken = legacyPinnedToken(wssComputers)
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(hubDbPath)
      try {
        db.exec('PRAGMA busy_timeout = 5000')
        const now = Date.now()
        db.prepare(
          `INSERT INTO join_tokens
             (id, token_hash, label, created_at, expires_at, used_at, computer_id, minted_by_user_id)
           VALUES (?, ?, 'older-hub', ?, ?, NULL, NULL, NULL)`
        ).run(
          `legacy-${randomBytes(4).toString('hex')}`,
          createHash('sha256').update(legacyToken, 'utf8').digest('hex'),
          now,
          now + 15 * 60_000
        )
      } finally {
        db.close()
      }

      writeFileSync(
        join(legacyRoot, 'computer.config.json'),
        JSON.stringify({ computerName: 'legacy-pin-computer', allowedRoots: [workDir] })
      )
      legacy = spawnElectronChild(COMPUTER_BIN, {
        ...scrubbedEnv(home),
        ...childCa,
        SLAYZONE_ROOT: legacyRoot,
        SLAYZONE_HUB_JOIN_TOKEN: legacyToken
      })
      const fresh = trpcOverFrontEnd(ownerToken)
      await poll(
        async () => {
          const r = (await fresh.computers.list.query()).find(
            (x) => x.name === 'legacy-pin-computer'
          )
          return r?.connected ? r : null
        },
        30_000,
        `legacy computer connected (logs:\n${legacy!.logs.join('\n')})`
      )
      assert(
        legacy!.logs.some((l) => l.includes('ignoring the certificate pin in the join token')),
        `the computer says it ignores the pin:\n${legacy!.logs.join('\n')}`
      )
    })

    await test('no process created an identity/ directory', async () => {
      for (const dir of [hubRoot, computerRoot, legacyRoot]) {
        assert(!existsSync(join(dir, 'identity')), `no identity/ under ${dir}`)
      }
    })
  } finally {
    for (const c of wsClients) c.close()
    if (legacy) await (legacy as Proc).stop()
    if (computer) await computer.stop()
    if (hub) await hub.stop()
    await front.close()
    restoreCa()
    ca.cleanup()
    rmSync(root, { recursive: true, force: true })
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed > 0 ? 1 : 0)
}

void main()
