/**
 * Test hubs for the mobile app's end-to-end Node scripts in this folder
 * (`record-chat-fixture.mts`, `two-hub-agents.mts`). Not run by any test suite.
 *
 * Each script boots its own hub(s) and computer(s) from this checkout's builds, signs a
 * phone account in the way the app does (password sign-in, then one bearer socket per
 * hub through the shared client runtime, with the Origin header iOS sends), runs the
 * app's own modules against them, and stops everything it started when it exits.
 *
 * - Builds first: `pnpm --filter @slayzone/hub build && pnpm --filter @slayzone/computer build`.
 * - Run from the repo root: `pnpm exec tsx packages/apps/mobile/scripts/<script>.mts`.
 * - State (hub database, owner file, computer enrolment, HOME, logs) goes to
 *   `logs/mobile-scripts/<script>/` (gitignored), wiped at the start of every run:
 *   never `~/.slayzone`, never the user's own hub. Passwords and tokens live only there.
 * - Hubs listen on loopback only, login required. Ports default to 47861 / 47862.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createFetchHubTransport,
  type HubFetch,
  signInWithPassword
} from '@slayzone/hub-auth/client'
import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'
import WS from 'ws'
// The client runtime the app's `FederationProvider` uses (not a package export).
import {
  closeHubClient,
  getOrCreateHubClient
} from '../../../shared/transport/src/client/runtime.ts'
import type { HubClient } from '../src/hub-board.ts'

/** The repository root. */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

/** A fresh state folder for one script: `logs/mobile-scripts/<name>`. */
export function freshStateDir(name: string): string {
  const dir = path.join(REPO, 'logs/mobile-scripts', name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

let failures = 0
/** One verified claim: printed, counted when false. */
export function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`)
  if (!ok) failures++
}
/** Count an unexpected error as a failure. */
export function fail(err: unknown): void {
  failures++
  console.error('ERROR', err)
}
/** Print the verdict and exit with it (every started process is stopped on exit). */
export function finish(): never {
  console.log(failures === 0 ? 'ALL OK' : `${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Polls `test` until it gives a value; throws after `ms`. */
export async function until<T>(
  what: string,
  test: () => T | undefined | null | false,
  ms = 20_000
): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = test()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`)
    await sleep(25)
  }
}

const ELECTRON = path.join(
  REPO,
  'node_modules/electron/dist',
  readFileSync(path.join(REPO, 'node_modules/electron/path.txt'), 'utf8').trim()
)

/** Run a built app (hub / computer) under Electron's Node (better-sqlite3's ABI). */
function runBuilt(
  bin: string,
  opts: { env: Record<string, string>; cwd?: string; log: string }
): () => void {
  if (!existsSync(bin)) throw new Error(`${bin} is missing: build it first (see test-hub.mts)`)
  const out = openSync(opts.log, 'a')
  const child = spawn(ELECTRON, [bin], {
    cwd: opts.cwd,
    env: { PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? '/tmp', ...opts.env },
    stdio: ['ignore', out, out]
  })
  const stop = (): void => {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  process.on('exit', stop)
  return stop
}

interface Reply {
  status: number
  json: unknown
  text: string
  headers: http.IncomingHttpHeaders
}

// node:http, not fetch: undici's Sec-Fetch-* headers trip better-auth's browser CSRF path.
function request(
  address: string,
  method: string,
  route: string,
  body?: unknown,
  token?: string
): Promise<Reply> {
  const [host, port] = address.split(':')
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        host,
        port: Number(port),
        method,
        path: route,
        agent: false,
        headers: {
          ...(data
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
            : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {})
        }
      },
      (res) => {
        let text = ''
        res.on('data', (c) => {
          text += c
        })
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(text)
          } catch {
            // Not JSON: `text` has the answer.
          }
          resolve({ status: res.statusCode ?? 0, json, text, headers: res.headers })
        })
      }
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

type Json = Record<string, unknown>
const field = (v: unknown, key: string): unknown =>
  v && typeof v === 'object' ? (v as Json)[key] : undefined

export interface TestHub {
  address: string
  /** A `user` account with a generated password (the hub owner creates it). */
  createUser(email: string): Promise<{ email: string; password: string }>
  /**
   * Enrol and run a computer owned by `forUser`, its folders jailed to `allowedRoot`
   * (`binOverrideDir`: executables that win over PATH, e.g. fake-claude's).
   */
  startComputer(opts: { forUser: string; allowedRoot: string; binOverrideDir?: string }): void
}

/** Boot a hub of this checkout in `dir` (state, HOME, logs) on 127.0.0.1:`port`. */
export async function startTestHub(opts: {
  name: string
  port: number
  dir: string
  binOverrideDir?: string
}): Promise<TestHub> {
  const address = `127.0.0.1:${opts.port}`
  const root = path.join(opts.dir, 'root')
  const home = path.join(opts.dir, 'home')
  mkdirSync(home, { recursive: true })
  runBuilt(path.join(REPO, 'packages/apps/hub/dist/bin.cjs'), {
    log: path.join(opts.dir, 'hub.log'),
    env: {
      HOME: home,
      SHELL: '/bin/bash',
      ELECTRON_RUN_AS_NODE: '1',
      SLAYZONE_ROOT: root,
      SLAYZONE_HUB_NAME: opts.name,
      SLAYZONE_HUB_LISTEN_ADDRESS: address,
      SLAYZONE_HUB_REQUIRE_LOGIN: '1',
      ...(opts.binOverrideDir ? { SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR: opts.binOverrideDir } : {})
    }
  })
  const ownerFile = path.join(root, 'hub.owner.json')
  await until('the hub writes its owner file', () => existsSync(ownerFile), 60_000)
  const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as { email: string; password: string }
  let ownerToken = ''
  for (let i = 0; i < 100 && !ownerToken; i++) {
    const res = await request(address, 'POST', '/api/auth/sign-in/email', owner).catch(() => null)
    const header = res?.headers['set-auth-token']
    ownerToken =
      (typeof header === 'string' ? header : String(field(res?.json, 'token') ?? '')) || ''
    if (!ownerToken) await sleep(200)
  }
  if (!ownerToken) throw new Error(`${opts.name}: the owner could not sign in`)

  let computers = 0
  return {
    address,
    async createUser(email) {
      const res = await request(address, 'POST', '/api/hub/users', { email }, ownerToken)
      const password = field(field(res.json, 'data'), 'password')
      if (res.status !== 200 || typeof password !== 'string') {
        throw new Error(`create user ${email}: ${res.status} ${res.text.slice(0, 200)}`)
      }
      return { email, password }
    },
    startComputer({ forUser, allowedRoot, binOverrideDir }) {
      const n = ++computers
      const croot = path.join(opts.dir, `computer-${n}`)
      mkdirSync(croot, { recursive: true })
      writeFileSync(
        path.join(croot, 'computer.config.json'),
        JSON.stringify({ computerName: `${opts.name}-computer-${n}`, allowedRoots: [allowedRoot] })
      )
      void request(
        address,
        'POST',
        '/api/computers/join-token',
        { label: `${opts.name}-${n}`, forUser },
        ownerToken
      ).then((minted) => {
        const token = field(minted.json, 'token')
        if (minted.status !== 200 || typeof token !== 'string') {
          fail(`join token: ${minted.status} ${minted.text.slice(0, 200)}`)
          return
        }
        runBuilt(path.join(REPO, 'packages/apps/computer/dist/bin.cjs'), {
          cwd: croot,
          log: path.join(opts.dir, `computer-${n}.log`),
          env: {
            HOME: home,
            SHELL: '/bin/bash',
            ELECTRON_RUN_AS_NODE: '1',
            SLAYZONE_NONINTERACTIVE: '1',
            SLAYZONE_ROOT: croot,
            SLAYZONE_HUB_ADDRESS: address,
            SLAYZONE_HUB_JOIN_TOKEN: token,
            ...(binOverrideDir ? { SLAYZONE_COMPUTER_BIN_OVERRIDE_DIR: binOverrideDir } : {})
          }
        })
      }, fail)
    }
  }
}

// iOS's WebSocket (SocketRocket) sends an Origin derived from the ws URL.
class RnLikeWebSocket extends WS {
  constructor(url: string, protocols?: string | string[]) {
    const u = new URL(url)
    super(url, protocols, { origin: `${u.protocol === 'wss:' ? 'https' : 'http'}://${u.host}` })
  }
}

const rnLikeFetch: HubFetch = (url, init) =>
  new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: init.method,
        agent: false,
        headers: {
          ...init.headers,
          ...(init.body ? { 'content-length': String(Buffer.byteLength(init.body)) } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              get: (name) => {
                const v = res.headers[name.toLowerCase()]
                return v == null ? null : Array.isArray(v) ? v.join(', ') : String(v)
              }
            },
            text: async () => Buffer.concat(chunks).toString('utf8')
          })
        )
      }
    )
    req.on('error', reject)
    if (init.body) req.write(init.body)
    req.end()
  })

export interface PhoneHub {
  /** The app's hub entry (`hub-session.ts` `hubEntryOf`). */
  entry: { id: string; kind: 'remote'; label: string; url: string }
  client: HubClient
  /** Drop the socket as a network loss would; the client reconnects and resubscribes. */
  dropSocket(): void
  close(): void
}

/** Sign in to a hub the way the app does and open its bearer socket. */
export async function signInPhone(
  address: string,
  account: { email: string; password: string }
): Promise<PhoneHub> {
  ;(globalThis as { WebSocket?: unknown }).WebSocket = RnLikeWebSocket
  const signed = await signInWithPassword(
    createFetchHubTransport(rnLikeFetch),
    hubUrlFromAddr(address, 'http'),
    account
  )
  if (!signed.ok) throw new Error(`sign-in to ${address}: ${signed.error}`)
  const url = hubUrlFromAddr(address, 'ws', '/trpc')
  const entry = { id: `hub:${url}`, kind: 'remote' as const, label: address, url }
  const ws = getOrCreateHubClient({ id: entry.id, url, token: signed.token })
  return {
    entry,
    // Re-typed for the app router, as the app's `ownerClient` does.
    client: ws.client as unknown as HubClient,
    dropSocket: () => {
      // @trpc/client's open socket (internal field names differ across minors).
      const internals = ws.wsClient as unknown as {
        activeConnection?: { ws?: { close(): void } | null }
        connection?: { ws?: { close(): void } | null }
      }
      ;(internals.activeConnection?.ws ?? internals.connection?.ws)?.close()
    },
    close: () => void closeHubClient(entry.id)
  }
}

/** A project of the phone's user with its folder `folder`, once a computer of theirs is up. */
export async function createProject(
  client: HubClient,
  input: { name: string; color: string; path: string }
): Promise<{ id: string }> {
  for (let i = 0; i < 150; i++) {
    try {
      return await client.projects.create.mutate(input)
    } catch (err) {
      if (!(err instanceof Error) || !/No computer is connected/.test(err.message)) throw err
      await sleep(200)
    }
  }
  throw new Error('no computer of the user connected in time')
}
