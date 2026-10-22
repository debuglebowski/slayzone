/**
 * `slayzone-hub break-glass open|end|status` — the operator half of break-glass
 * (break-glass.ts), run ON the hub machine (Azure Run Command, as root or the hub's OS
 * user). It talks to the RUNNING hub over the local admin socket (hub-admin-socket.ts);
 * it never touches the database, starts nothing and writes nothing.
 *
 *   open --challenge <C> [--ttl 30m]   open a grant for the challenge `slay hub
 *                                      break-glass start` printed on the laptop
 *   end                                end the grant or session now
 *   status                             idle | pending | active, with times
 *   --root <ROOT>                      the hub's data root (default: SLAYZONE_ROOT, else
 *                                      ~/.slayzone of the user running this)
 *
 * Nothing it prints is secret: Azure keeps Run Command output, so the output names the
 * grant and its expiry only. On a hub without login there is no socket and it refuses
 * (exit 1) — the desktop app's hub has nothing to break into.
 *
 * @module hub/break-glass-command
 */
import { userInfo } from 'node:os'
import { getSlayzoneHomeDir } from '@slayzone/platform'
import { BREAK_GLASS_DEFAULT_TTL_MS, type BreakGlassOperator } from './break-glass.js'
import {
  callHubAdminSocket,
  HUB_ADMIN_SOCKET_PROTOCOL,
  resolveHubAdminSocketPath
} from './hub-admin-socket.js'

const USAGE = `usage: slayzone-hub break-glass <open|end|status> [options]

  open --challenge <code> [--ttl <30m>]  open a grant for the code \`slay hub break-glass start\` printed
  end                                     end the open grant or session now
  status                                  show whether a grant or session is open

  --root <dir>   the hub's data root (default: $SLAYZONE_ROOT, else ~/.slayzone)
  --ttl <dur>    session lifetime once redeemed: <n>m or <n>h, 1m..2h (default 30m)`

/** `30m`, `2h`, `90s` → ms; null when it is none of those. */
export function parseDuration(value: string): number | null {
  const match = /^(\d+)(s|m|h)$/.exec(value.trim())
  if (!match) return null
  const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as 's' | 'm' | 'h']
  return Number(match[1]) * unit
}

export interface BreakGlassCommandArgs {
  op: 'open' | 'end' | 'status'
  root: string | null
  challenge: string | null
  ttlMs: number | null
}

/** Parse `break-glass …` argv (everything after `break-glass`). Throws a usage error. */
export function parseBreakGlassArgs(argv: readonly string[]): BreakGlassCommandArgs {
  const [op, ...rest] = argv
  if (op !== 'open' && op !== 'end' && op !== 'status') throw new Error(USAGE)
  const out: BreakGlassCommandArgs = { op, root: null, challenge: null, ttlMs: null }
  for (let i = 0; i < rest.length; i++) {
    const [flag, inline] = rest[i]!.split(/=(.*)/s, 2) as [string, string | undefined]
    const value = (): string => {
      const v = inline ?? rest[++i]
      if (v === undefined || v === '') throw new Error(`${flag} needs a value\n\n${USAGE}`)
      return v
    }
    if (flag === '--root') out.root = value()
    else if (flag === '--challenge' && op === 'open') out.challenge = value()
    else if (flag === '--ttl' && op === 'open') {
      const raw = value()
      const ms = parseDuration(raw)
      if (ms === null) throw new Error(`--ttl ${raw}: expected <n>m or <n>h, e.g. 30m\n\n${USAGE}`)
      out.ttlMs = ms
    } else throw new Error(`unknown option ${flag}\n\n${USAGE}`)
  }
  if (op === 'open' && !out.challenge) throw new Error(`open needs --challenge\n\n${USAGE}`)
  return out
}

/** Who is running this, as recorded in the audit line (not a credential: see the socket). */
export function currentOperator(env: NodeJS.ProcessEnv = process.env): BreakGlassOperator {
  let osUser: string | null = null
  let uid: number | null = null
  try {
    const info = userInfo()
    osUser = info.username || null
    uid = info.uid >= 0 ? info.uid : null
  } catch {
    /* no passwd entry: record nothing */
  }
  return { osUser, uid, sudoUser: env.SUDO_USER || null }
}

const at = (ms: unknown): string => (typeof ms === 'number' ? new Date(ms).toISOString() : '?')

/** Run the command; resolves to the exit code. Output goes to `out` / `err`. */
export async function runBreakGlassCommand(
  argv: readonly string[],
  io: { out: (line: string) => void; err: (line: string) => void } = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`)
  }
): Promise<number> {
  let args: BreakGlassCommandArgs
  try {
    args = parseBreakGlassArgs(argv)
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e))
    return 2
  }
  const root = args.root ?? getSlayzoneHomeDir()
  const socketPath = resolveHubAdminSocketPath(root)
  if (!socketPath) {
    io.err(
      `break-glass is not available for the hub at ${root} (Windows, or the path is too long).`
    )
    return 1
  }
  const by = currentOperator()
  let reply: Record<string, unknown>
  try {
    reply = await callHubAdminSocket(
      socketPath,
      args.op === 'open'
        ? {
            v: HUB_ADMIN_SOCKET_PROTOCOL,
            op: 'open',
            challenge: args.challenge!,
            ttlMs: args.ttlMs ?? BREAK_GLASS_DEFAULT_TTL_MS,
            by
          }
        : args.op === 'end'
          ? { v: HUB_ADMIN_SOCKET_PROTOCOL, op: 'end', by }
          : { v: HUB_ADMIN_SOCKET_PROTOCOL, op: 'status' }
    )
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ECONNREFUSED') {
      io.err(
        `No hub with break-glass is running at ${root} (${socketPath} is absent).\n` +
          'Either the hub is not running, --root names the wrong directory, or the hub does ' +
          'not require login (the desktop app’s hub has no break-glass).'
      )
    } else if (code === 'EACCES') {
      io.err(`Permission denied on ${socketPath}: run this as the hub's OS user or root.`)
    } else {
      io.err(`break-glass: ${e instanceof Error ? e.message : String(e)}`)
    }
    return 1
  }
  if (reply.ok !== true) {
    io.err(`Refused: ${typeof reply.error === 'string' ? reply.error : 'unknown error'}`)
    return 1
  }
  if (args.op === 'open') {
    io.out(`Break-glass grant ${String(reply.ref)} is open.`)
    if (reply.replaced === true) io.out('(It replaces the grant that was still pending.)')
    io.out(
      `Redeem it by ${at(reply.grantExpiresAt)}: press Enter in \`slay hub break-glass start\`.`
    )
    io.out(
      `The session will last ${Number(reply.ttlMs) / 60_000} min from then. ` +
        'End it early with `slayzone-hub break-glass end`.'
    )
    return 0
  }
  if (args.op === 'end') {
    const ended = (reply.ended ?? {}) as { grant?: boolean; session?: boolean }
    io.out(
      ended.session
        ? 'Break-glass session ended: the account is disabled and everything it held is revoked.'
        : ended.grant
          ? 'Pending break-glass grant cancelled.'
          : 'Nothing was open.'
    )
    return 0
  }
  const status = (reply.status ?? {}) as Record<string, unknown>
  if (status.state === 'active') {
    io.out(`Session ${String(status.ref)} open until ${at(status.expiresAt)}.`)
  } else if (status.state === 'pending') {
    io.out(`Grant ${String(status.ref)} waiting to be redeemed until ${at(status.grantExpiresAt)}.`)
  } else {
    io.out('Idle: no break-glass grant or session.')
  }
  return 0
}
