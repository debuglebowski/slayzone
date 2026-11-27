import { closeSync, readFileSync } from 'node:fs'
import { HUB_CREDENTIALS_ENV } from '@slayzone/platform/hub-switches'

/**
 * Where this hub's integration-credentials key comes from, read ONCE at boot before
 * anything is spawned, and then removed from `process.env` — git, its hooks, a repo's
 * setup script, terminals and agents all inherit the hub's environment (review M1).
 *
 *   - `pipe`: the desktop app writes `{ current, previous[] }` (JSON) on an inherited
 *     file descriptor named by `SLAYZONE_HUB_CREDENTIALS_FD` and closes it. The keys
 *     are never in any environment, so `ps eww` shows nothing either.
 *   - `env`: an operator's `SLAYZONE_HUB_CREDENTIALS_SECRET`. Removed after reading so
 *     no child inherits it; `ps eww` still shows the hub's initial environment, which
 *     is the operator's choice of channel (docs: prefer the derived key).
 *   - `none`: the key derives from the hub auth secret (credentials-key.ts).
 */
export interface CredentialsSecretInput {
  secret: string | null
  previous: string[]
  source: 'pipe' | 'env' | 'none'
}

export function readCredentialsSecretInput(env: NodeJS.ProcessEnv): CredentialsSecretInput {
  const fdVar = env[HUB_CREDENTIALS_ENV.fd]
  const secretVar = env[HUB_CREDENTIALS_ENV.secret]
  delete env[HUB_CREDENTIALS_ENV.fd]
  delete env[HUB_CREDENTIALS_ENV.secret]
  if (fdVar !== undefined && /^\d+$/.test(fdVar)) {
    const fd = Number(fdVar)
    let raw = ''
    try {
      raw = readFileSync(fd, 'utf8')
    } catch {
      /* not readable: no key this session */
    } finally {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    }
    try {
      const parsed = JSON.parse(raw) as { current?: unknown; previous?: unknown }
      const current = typeof parsed.current === 'string' && parsed.current ? parsed.current : null
      const previous = Array.isArray(parsed.previous)
        ? parsed.previous.filter((p): p is string => typeof p === 'string' && p.length > 0)
        : []
      return { secret: current, previous, source: 'pipe' }
    } catch {
      return { secret: null, previous: [], source: 'pipe' }
    }
  }
  if (secretVar) return { secret: secretVar, previous: [], source: 'env' }
  return { secret: null, previous: [], source: 'none' }
}

let taken: CredentialsSecretInput | null = null

/**
 * The process's input, read from `process.env` the first time (bin.ts calls this
 * before the server starts; composition gets the same answer).
 */
export function takeCredentialsSecretInput(): CredentialsSecretInput {
  taken ??= readCredentialsSecretInput(process.env)
  return taken
}
