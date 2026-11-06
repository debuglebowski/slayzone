/**
 * Run gh on THIS machine: the resolved binary with argv, no shell (through the
 * user's interactive shell its startup output landed on gh's JSON stdout).
 * `execAsync` supplies the login-shell PATH. Not the hub's: the hub has no local
 * `gh` (its executor routes to a computer, else "connect a computer"); kept for
 * hosts that run gh themselves and for tests.
 */
import { whichBinary } from '@slayzone/terminal/server'
import { execAsync } from './exec-async'
import { GhNotFoundError, type GhExecutor } from './gh-cli'

let ghPath: string | null | undefined

async function resolveGhPath(): Promise<string | null> {
  if (ghPath !== undefined) return ghPath
  ghPath = await whichBinary('gh')
  return ghPath
}

export const runGhLocally: GhExecutor = async (args, opts) => {
  const gh = await resolveGhPath()
  if (!gh) throw new GhNotFoundError()
  return execAsync(gh, args, { ...opts, source: 'gh' })
}
