/**
 * `slay computer mint` at the command level (T-20): `--for <user>` names who the
 * computer is for, `--ttl` is capped at the hub's 60 minutes before anything is sent,
 * and a hub with login refusing a mint that names nobody comes back with how to fix it.
 *
 * The hub is a fake HTTP server on loopback, addressed through `SLAYZONE_HUB_ADDRESS`,
 * that answers `POST /api/computers/join-token` the way a hub with login does (400
 * `JOIN_TOKEN_OWNER_REQUIRED` without `forUser`). The real route's rules are covered
 * by transport's `rest-api/computers/join-token.test.ts`. Pure Node → plain tsx.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { captureAllAsync } from '../../test/test-harness'
import { computerCommand } from './computer'

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

interface Seen {
  auth: string | null
  body: Record<string, unknown>
}

const TOKEN = `szjt1.${Buffer.from(JSON.stringify({ hubUrl: 'wss://hub.example/computers', secret: 's' })).toString('base64url')}`

async function startHub(): Promise<{ port: number; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      seen.push({ auth: req.headers.authorization ?? null, body })
      res.setHeader('content-type', 'application/json')
      if (req.method !== 'POST' || req.url !== '/api/computers/join-token') {
        res.statusCode = 404
        res.end('{}')
      } else if (typeof body.forUser !== 'string') {
        res.statusCode = 400
        res.end(
          JSON.stringify({
            error: 'name the user this computer is for',
            code: 'JOIN_TOKEN_OWNER_REQUIRED'
          })
        )
      } else {
        res.end(JSON.stringify({ token: TOKEN, hubUrl: 'wss://hub.example/computers' }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { port, seen, close: () => new Promise((resolve) => server.close(() => resolve())) }
}

function mint(args: string[]) {
  return captureAllAsync(async () => {
    await computerCommand().parseAsync(['mint', ...args], { from: 'user' })
  })
}

async function main(): Promise<void> {
  console.log('\nslay computer mint (T-20)')
  const hub = await startHub()
  const saved = { addr: process.env.SLAYZONE_HUB_ADDRESS, token: process.env.SLAYZONE_HUB_TOKEN }
  process.env.SLAYZONE_HUB_ADDRESS = `127.0.0.1:${hub.port}`
  process.env.SLAYZONE_HUB_TOKEN = 'admin-bearer'
  try {
    {
      const out = await mint(['lab-box', '--for', 'bob@example.com', '--json'])
      const sent = hub.seen.at(-1)
      check('--for: exits 0', out.exitCode === null, out.stderr.join('\n'))
      check(
        '--for: sends forUser, the label and the default 15 minutes, as the signed-in caller',
        sent?.body.forUser === 'bob@example.com' &&
          sent.body.label === 'lab-box' &&
          sent.body.ttlMs === 15 * 60_000 &&
          sent.auth === 'Bearer admin-bearer',
        JSON.stringify(sent)
      )
      check(
        '--for: prints the token',
        (JSON.parse(out.stdout.join('\n')) as { token?: string }).token === TOKEN
      )
    }

    {
      const out = await mint(['lab-box', '--for', 'u-bob'])
      check(
        'text output names who it is for',
        out.stdout.includes('For:   u-bob'),
        out.stdout.join('\n')
      )
    }

    {
      const out = await mint(['lab-box', '--json'])
      const err = out.stderr.join('\n')
      check('no --for on a hub with login: exits 1', out.exitCode === 1)
      check('…says what the hub said', err.includes('name the user this computer is for'), err)
      check(
        '…and how to fix it',
        err.includes('slay computer mint lab-box --for <email>') &&
          err.includes('slay hub users ls'),
        err
      )
      check('…having sent no forUser', !('forUser' in (hub.seen.at(-1)?.body ?? {})))
    }

    {
      const before = hub.seen.length
      const out = await mint(['lab-box', '--for', 'u-bob', '--ttl', '61'])
      const err = out.stderr.join('\n')
      check('--ttl over 60 minutes: exits 1', out.exitCode === 1)
      check('…naming the cap', err.includes('at most 60 minutes'), err)
      check('…before calling the hub', hub.seen.length === before)
    }

    {
      const out = await mint(['lab-box', '--for', 'u-bob', '--ttl', '60', '--json'])
      check('--ttl 60: allowed', out.exitCode === null, out.stderr.join('\n'))
      check('…sent as 1 hour', hub.seen.at(-1)?.body.ttlMs === 60 * 60_000)
    }

    {
      const before = hub.seen.length
      const out = await mint(['lab-box', '--for', '   '])
      check(
        'blank --for: exits 1 before calling the hub',
        out.exitCode === 1 && hub.seen.length === before
      )
    }
  } finally {
    if (saved.addr === undefined) delete process.env.SLAYZONE_HUB_ADDRESS
    else process.env.SLAYZONE_HUB_ADDRESS = saved.addr
    if (saved.token === undefined) delete process.env.SLAYZONE_HUB_TOKEN
    else process.env.SLAYZONE_HUB_TOKEN = saved.token
    await hub.close()
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
