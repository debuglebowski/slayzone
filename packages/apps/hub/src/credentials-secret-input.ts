import { closeSync, createReadStream, readSync } from 'node:fs'
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

function parseKeys(line: string): CredentialsSecretInput {
  try {
    const parsed = JSON.parse(line) as { current?: unknown; previous?: unknown }
    const current = typeof parsed.current === 'string' && parsed.current ? parsed.current : null
    const previous = Array.isArray(parsed.previous)
      ? parsed.previous.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : []
    return { secret: current, previous, source: 'pipe' }
  } catch {
    return { secret: null, previous: [], source: 'pipe' }
  }
}

/** The pipe stays open after the first line (L4): later lines are later keys. */
let openPipe: { fd: number; rest: string } | null = null

/**
 * Read the first line (or everything up to EOF) from `fd`, synchronously — the
 * desktop writes it at spawn. Returns what came after it, unparsed.
 */
function readFirstLine(fd: number): { line: string; rest: string; eof: boolean } {
  const chunk = Buffer.alloc(4096)
  let text = ''
  for (;;) {
    let n = 0
    try {
      n = readSync(fd, chunk, 0, chunk.length, null)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') continue
      return { line: text, rest: '', eof: true }
    }
    if (n === 0) return { line: text, rest: '', eof: true }
    text += chunk.subarray(0, n).toString('utf8')
    const nl = text.indexOf('\n')
    if (nl >= 0) return { line: text.slice(0, nl), rest: text.slice(nl + 1), eof: false }
  }
}

export function readCredentialsSecretInput(
  env: NodeJS.ProcessEnv,
  opts: { keepOpen?: boolean } = {}
): CredentialsSecretInput {
  const fdVar = env[HUB_CREDENTIALS_ENV.fd]
  const secretVar = env[HUB_CREDENTIALS_ENV.secret]
  delete env[HUB_CREDENTIALS_ENV.fd]
  delete env[HUB_CREDENTIALS_ENV.secret]
  if (fdVar !== undefined && /^\d+$/.test(fdVar)) {
    const fd = Number(fdVar)
    const { line, rest, eof } = readFirstLine(fd)
    if (opts.keepOpen && !eof) {
      openPipe = { fd, rest }
    } else {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    }
    return parseKeys(line)
  }
  if (secretVar) return { secret: secretVar, previous: [], source: 'env' }
  return { secret: null, previous: [], source: 'none' }
}

/**
 * Keys the desktop sends AFTER the hub started (a keychain prompt answered late, L4):
 * one JSON line each, on the pipe the first line came on. Returns the stop function.
 * Nothing to watch when the keys came another way or the pipe already ended.
 */
export function watchCredentialsUpdates(
  listener: (input: CredentialsSecretInput) => void
): () => void {
  const pipe = openPipe
  if (!pipe)
    return () => {
      // Nothing was watched: keys came another way, or the pipe already ended.
    }
  openPipe = null
  let buffered = pipe.rest
  const stream = createReadStream('', { fd: pipe.fd, autoClose: true, encoding: 'utf8' })
  const flush = (): void => {
    for (;;) {
      const nl = buffered.indexOf('\n')
      if (nl < 0) return
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      if (line.trim()) listener(parseKeys(line))
    }
  }
  stream.on('data', (chunk) => {
    buffered += chunk
    flush()
  })
  stream.on('error', () => {
    /* the desktop went away: nothing more will come */
  })
  flush()
  return () => {
    stream.destroy()
  }
}

let taken: CredentialsSecretInput | null = null

/**
 * The process's input, read from `process.env` the first time (bin.ts calls this
 * before the server starts; composition gets the same answer).
 */
export function takeCredentialsSecretInput(): CredentialsSecretInput {
  taken ??= readCredentialsSecretInput(process.env, { keepOpen: true })
  return taken
}
