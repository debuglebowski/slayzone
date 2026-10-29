/**
 * `slay hub break-glass start|end` and `slay hub computers ls|revoke|unrevoke` — the
 * laptop side of break-glass v2 (hub `break-glass.ts`), and the computer management a
 * break-glass session (or any admin) does from the CLI.
 *
 * `start <url>` draws a random VERIFIER that never leaves this process, prints the
 * command to run on the hub machine with its CHALLENGE (base64url SHA-256 — a hash, so
 * Azure keeping the Run Command script and output reveals nothing usable), waits for the
 * operator to press Enter, then redeems: `POST /api/auth/break-glass { verifier }`. The
 * session token comes back and is stored in a file of its own (0600
 * `break-glass[.dev].json`), which hub commands — `slay hub users …` / `slay hub
 * computers …` — use until it expires. It never touches the hub target `slay hub
 * use` / `hub login` stored: a break-glass session is a detour, and ending it must
 * leave things where they were. `end` ends the session early and forgets the token.
 *
 * @module cli/commands/hub-break-glass
 */
import { createHash, randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { Command } from 'commander'
import {
  normalizeHubUrl,
  readBreakGlassSession,
  removeBreakGlassSession,
  removeHubConfig,
  resolveHubCommandTarget,
  writeBreakGlassSession
} from '../hub-config'
import { hubRequest, resolveHubRequestTarget } from '../hub-request'
import { fail } from '../service'

const BREAK_GLASS_PATH = '/api/auth/break-glass'
const BREAK_GLASS_TOKEN_PREFIX = 'szbg_'

/** A fresh verifier and the challenge the hub machine is given (hub `breakGlassChallenge`). */
export function newBreakGlassVerifier(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier, 'utf8').digest('base64url') }
}

type RedeemOutcome =
  | { ok: true; token: string; expiresAt: string; email: string }
  | { ok: false; status: number; error: string }

async function redeem(baseUrl: string, verifier: string): Promise<RedeemOutcome> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}${BREAK_GLASS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verifier }),
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    return { ok: false, status: 0, error: `could not reach the hub at ${baseUrl}` }
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (res.ok && typeof body.token === 'string') {
    return {
      ok: true,
      token: body.token,
      expiresAt: String(body.expiresAt ?? '?'),
      email: String(body.email ?? 'the break-glass account')
    }
  }
  return {
    ok: false,
    status: res.status,
    error: typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
  }
}

/** `slay hub break-glass` */
export function hubBreakGlassCommand(): Command {
  const cmd = new Command('break-glass')
    .description('Emergency admin access to a hub whose sign-in is down (needs the hub machine)')
    .showHelpAfterError(true)

  cmd
    .command('start <url>')
    .description('Get a short-lived admin session, opened by an operator on the hub machine')
    .option('--ttl <duration>', 'Session lifetime once redeemed: <n>m or <n>h, 1m..2h', '30m')
    .action(async (rawUrl: string, opts: { ttl: string }) => {
      const url = normalizeHubUrl(rawUrl)
      if (!url) fail(`Invalid hub URL (expected an http(s) URL): ${rawUrl}`)
      if (!/^\d+[mh]$/.test(opts.ttl)) fail(`--ttl ${opts.ttl}: expected <n>m or <n>h, e.g. 30m`)
      const { verifier, challenge } = newBreakGlassVerifier()
      console.log(
        'Run this ON THE HUB MACHINE, as the hub’s OS user or root (e.g. Azure Run Command):'
      )
      console.log('')
      console.log(
        `  slayzone-hub break-glass open --challenge ${challenge} --ttl ${opts.ttl} --root <hub ROOT>`
      )
      console.log('')
      console.log(
        'The challenge is a hash: the command and its output are safe to keep. The secret it\n' +
          'answers stays in this process — keep this window open. The grant lasts 10 minutes.'
      )
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: process.stdin.isTTY === true
      })
      const lines = rl[Symbol.asyncIterator]()
      try {
        for (;;) {
          process.stdout.write('\nPress Enter once it has run (q to give up): ')
          const next = await lines.next()
          if (next.done || String(next.value).trim().toLowerCase() === 'q') {
            fail('Gave up: nothing was redeemed.')
          }
          const outcome = await redeem(url, verifier)
          if (outcome.ok) {
            const sessionPath = writeBreakGlassSession({
              url,
              token: outcome.token,
              expiresAt: outcome.expiresAt
            })
            console.log(
              `\nBreak-glass session open as ${outcome.email} until ${outcome.expiresAt}.`
            )
            console.log(
              `Session stored: ${sessionPath}. Hub commands use it until it ends; ` +
                'the stored hub target is unchanged.'
            )
            console.log('')
            console.log('  slay hub users ls | disable <email> | enable <email>')
            console.log('  slay hub computers ls | revoke <id> | unrevoke <id>')
            console.log('  slay hub break-glass end      (when done)')
            return
          }
          if (outcome.status === 403) {
            console.error(`Not redeemed: ${outcome.error}`)
            continue
          }
          fail(`Break-glass failed: ${outcome.error}`)
        }
      } finally {
        rl.close()
      }
    })

  cmd
    .command('end')
    .description('End this CLI’s break-glass session now and forget its token')
    .action(async () => {
      // The stored session even when it has expired: `end` is also how it is cleared.
      // Failing that, a session an older CLI stored AS the hub target, before sessions
      // had a file of their own.
      const session = readBreakGlassSession()
      const target = session
        ? { baseUrl: session.url, token: session.token, source: 'break-glass' as const }
        : resolveHubCommandTarget()
      if (!target?.token?.startsWith(BREAK_GLASS_TOKEN_PREFIX)) {
        fail(
          'No break-glass session is stored for this CLI. On the hub machine, ' +
            '`slayzone-hub break-glass end` ends any.'
        )
      }
      let res: Response
      try {
        res = await fetch(`${target.baseUrl}${BREAK_GLASS_PATH}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${target.token}` },
          signal: AbortSignal.timeout(10_000)
        })
      } catch {
        fail(
          `Could not reach the hub at ${target.baseUrl}. The session stays stored; ` +
            'it ends on its own when it expires.'
        )
      }
      // 401: the hub no longer knows the token — it expired, or was ended on the hub
      // machine. Nothing left to end, so forget it here too.
      const alreadyEnded = res.status === 401
      if (!res.ok && !alreadyEnded) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown }
        fail(
          `Break-glass end failed: ${typeof body.error === 'string' ? body.error : `HTTP ${res.status}`}`
        )
      }
      if (target.source === 'break-glass') removeBreakGlassSession()
      else if (target.source === 'file') removeHubConfig()
      console.log(
        alreadyEnded
          ? 'The break-glass session had already ended (expired, or ended on the hub machine); its token is forgotten.'
          : 'Break-glass session ended: the account is disabled and its token forgotten.'
      )
    })

  return cmd
}

interface ComputerRow {
  id: string
  name: string
  platform: string | null
  lastSeenAt: number | null
  connected: boolean
}

function hubComputersRequest<T>(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  return resolveHubRequestTarget('hub computers …').then((target) =>
    hubRequest<T>({
      target,
      path,
      method,
      ...(body === undefined ? {} : { body }),
      unwrap: path === '/api/computers' ? 'raw' : 'data'
    })
  )
}

/** `slay hub computers` — the computers enrolled on a hub, as its admin manages them. */
export function hubComputersCommand(): Command {
  const computers = new Command('computers')
    .description('List, revoke and restore the computers enrolled on a hub (admin)')
    .showHelpAfterError(true)

  computers
    .command('ls')
    .description('List the computers enrolled on a hub (not revoked)')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      const rows = await hubComputersRequest<ComputerRow[]>('GET', '/api/computers')
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2))
        return
      }
      if (rows.length === 0) {
        console.log('No computers enrolled.')
        return
      }
      const idW = Math.max(2, ...rows.map((r) => r.id.length))
      const nameW = Math.max(4, ...rows.map((r) => r.name.length))
      console.log(`${'ID'.padEnd(idW)}  ${'NAME'.padEnd(nameW)}  CONNECTED  LAST SEEN`)
      for (const r of rows) {
        const seen = r.lastSeenAt ? new Date(r.lastSeenAt).toISOString().slice(0, 16) : '-'
        console.log(
          `${r.id.padEnd(idW)}  ${r.name.padEnd(nameW)}  ${(r.connected ? 'yes' : 'no').padEnd(9)}  ${seen}`
        )
      }
    })

  computers
    .command('revoke <id>')
    .description('Revoke a computer: drop its connection and refuse its key (reversible)')
    .action(async (id: string) => {
      await hubComputersRequest('PATCH', '/api/hub/computers', { id, revoked: true })
      console.log(`Revoked computer ${id}. Undo with \`slay hub computers unrevoke ${id}\`.`)
    })

  computers
    .command('unrevoke <id>')
    .description('Restore a revoked computer')
    .action(async (id: string) => {
      await hubComputersRequest('PATCH', '/api/hub/computers', { id, revoked: false })
      console.log(`Restored computer ${id}.`)
    })

  return computers
}
