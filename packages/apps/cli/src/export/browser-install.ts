/**
 * `--install-browser`: download Chrome for Testing's `chrome-headless-shell` (Stable
 * channel, this OS/arch) into the per-user cache, once. Discovery step 3
 * (`findCachedHeadlessShell`) finds it from then on, so the flag is not needed again.
 *
 * The install is atomic: the zip lands in a temp work dir, unpacks there, and the
 * unpacked dir is renamed into place only once the binary is there and executable.
 * Discovery only looks at plain version-named dirs, so a crash mid-install leaves
 * nothing it would pick up. Several installs may run at once (parallel agents, each
 * its own `slay`): the rename is the commit, and whoever finds the version already in
 * place keeps it — a version dir holding a working executable is never deleted.
 *
 * The download must come from Chrome for Testing's own bucket ({@link CFT_DOWNLOAD_PREFIX},
 * the only place the version list names): no hash is published, so the source is the
 * one check on a binary that is then run. Every hop is https (a redirect to plain http
 * is refused) and the download is capped while it streams.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as StreamWebReadable } from 'node:stream/web'
import {
  type BrowserEnv,
  cftPlatformFor,
  findCachedHeadlessShell,
  headlessShellBinaryRel,
  headlessShellCacheRoot,
  VERSION_RE
} from './browser'
import { extractZip } from './zip-extract'
import { onExitOrSignal } from './signal-cleanup'

export { cftPlatformFor }

export const CFT_VERSIONS_URL =
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'

/**
 * Where every Chrome for Testing download lives (checked against the live version
 * lists: all their URLs are in this bucket). The bucket, not just the host:
 * storage.googleapis.com serves anyone's bucket.
 */
export const CFT_DOWNLOAD_HOST = 'storage.googleapis.com'
export const CFT_DOWNLOAD_PREFIX = `https://${CFT_DOWNLOAD_HOST}/chrome-for-testing-public/`

export class BrowserInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserInstallError'
  }
}

interface CftDownload {
  platform?: unknown
  url?: unknown
}

/** The Stable headless-shell build for `cftPlatform`, or null when CfT has none. */
export function selectHeadlessShellDownload(
  doc: unknown,
  cftPlatform: string
): { version: string; url: string } | null {
  const stable = (doc as { channels?: { Stable?: { version?: unknown; downloads?: unknown } } })
    ?.channels?.Stable
  const version = stable?.version
  const list = (stable?.downloads as Record<string, unknown> | undefined)?.['chrome-headless-shell']
  if (typeof version !== 'string' || !Array.isArray(list)) {
    throw new BrowserInstallError('Unexpected Chrome for Testing version list format.')
  }
  // The version names a cache directory: never let the document pick an arbitrary path.
  if (!VERSION_RE.test(version)) {
    throw new BrowserInstallError(`Unexpected Chrome for Testing version: ${version}`)
  }
  const hit = (list as CftDownload[]).find((d) => d?.platform === cftPlatform)
  if (!hit) return null
  if (typeof hit.url !== 'string' || !hit.url.startsWith('https://')) {
    throw new BrowserInstallError(`Refusing non-https download URL: ${String(hit.url)}`)
  }
  return { version, url: pinnedDownloadUrl(hit.url) }
}

/**
 * `url` parsed, normalised (`..` and `%2e%2e` resolved) and checked to sit inside
 * {@link CFT_DOWNLOAD_PREFIX}: no other host, port, credentials or bucket. The
 * normalised form is what gets fetched, so what was checked is what is downloaded.
 */
function pinnedDownloadUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new BrowserInstallError(`Refusing download URL: ${url}`)
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== CFT_DOWNLOAD_HOST ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    !parsed.href.startsWith(CFT_DOWNLOAD_PREFIX)
  ) {
    throw new BrowserInstallError(
      `Refusing download URL outside Chrome for Testing (${CFT_DOWNLOAD_PREFIX}): ${url}`
    )
  }
  return parsed.href
}

function noBuildMessage(platform: string, arch: string, cft: string | null): string {
  const what = cft ?? `${platform}/${arch}`
  return (
    `Chrome for Testing publishes no headless Chromium for ${what}.\n` +
    'Install Chromium with your package manager (e.g. `sudo apt-get install chromium`),\n' +
    'or pass --browser <path> to a Chrome/Chromium/Edge executable.'
  )
}

/** Redirect hops followed before giving up. */
const MAX_REDIRECTS = 10
/** The headless shell zip is ~100–200 MB; anything past this is not it. */
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024
/** The CfT version list is tens of KB. */
const MAX_JSON_BYTES = 16 * 1024 * 1024

function refuseNonHttps(url: string, via: string): void {
  if (!url.startsWith('https://')) {
    throw new BrowserInstallError(`Refusing non-https download URL: ${url} (from ${via})`)
  }
}

/**
 * GET `url`, following redirects by hand so that every hop — not just the first —
 * must be https: a plain-http hop could be rewritten by anyone on the path.
 */
async function fetchOk(fetchImpl: typeof fetch, url: string): Promise<Response> {
  let current = url
  for (let hop = 0; ; hop++) {
    refuseNonHttps(current, url)
    let res: Response
    try {
      res = await fetchImpl(current, { redirect: 'manual' })
    } catch (err) {
      throw new BrowserInstallError(`Download failed (${current}): ${(err as Error).message}`)
    }
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) {
        throw new BrowserInstallError(`Download failed (${url}): too many redirects`)
      }
      await res.body?.cancel().catch(() => undefined)
      current = new URL(location, current).toString()
      continue
    }
    // A fetch that followed redirects itself reports where it ended up.
    if (res.url) refuseNonHttps(res.url, url)
    if (!res.ok) throw new BrowserInstallError(`Download failed (${current}): HTTP ${res.status}`)
    return res
  }
}

/** The response body, refused once it passes `max` bytes (declared or streamed). */
function cappedBody(res: Response, url: string, max: number): Readable {
  const tooBig = (): BrowserInstallError =>
    new BrowserInstallError(`Download failed (${url}): larger than ${max} bytes`)
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) throw tooBig()
  if (!res.body) throw new BrowserInstallError(`Download failed (${url}): empty body`)
  const source = Readable.fromWeb(res.body as unknown as StreamWebReadable)
  let seen = 0
  const counted = new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length
      if (seen > max) done(tooBig())
      else done(null, chunk)
    }
  })
  // Errors cross both ways: a dropped connection fails the reader, and a refused
  // body stops the transfer (the caller's pipeline rejects with tooBig()).
  source.on('error', (err) => counted.destroy(err))
  counted.on('error', () => source.destroy())
  return source.pipe(counted)
}

async function readJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const parts: Buffer[] = []
  for await (const chunk of cappedBody(await fetchOk(fetchImpl, url), url, MAX_JSON_BYTES)) {
    parts.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch {
    throw new BrowserInstallError(`Unexpected Chrome for Testing version list (${url}): not JSON`)
  }
}

export interface InstallOptions {
  ctx: BrowserEnv
  fetchImpl?: typeof fetch
  /** Progress lines (stderr in the CLI: stdout carries the output path). */
  log: (line: string) => void
  /** Download size cap (default {@link MAX_DOWNLOAD_BYTES}); tests lower it. */
  maxDownloadBytes?: number
}

/** Leftovers older than this belong to an install that died; younger may be running. */
const STALE_INSTALL_MS = 3600_000

/**
 * Remove what an interrupted install left in the cache: its work dir (`.install-*`)
 * and the layout older releases used (`.download-*.zip`, `<version>.partial-*`).
 * Only entries over an hour old — a younger one may be another `slay` installing now.
 */
function sweepStaleInstalls(root: string, now = Date.now()): void {
  for (const name of fs.readdirSync(root)) {
    // Each leftover on its own: one that cannot be removed must not stop the sweep.
    try {
      if (!/^\.install-|^\.download-|\.partial-/.test(name)) continue
      const p = path.join(root, name)
      if (now - fs.lstatSync(p).mtimeMs > STALE_INSTALL_MS)
        fs.rmSync(p, { recursive: true, force: true })
    } catch {
      // Gone already (another run swept it), or not removable: the next run retries.
    }
  }
}

/** Rename attempts before giving up on a version dir that keeps changing under us. */
const COMMIT_ATTEMPTS = 5

/**
 * Move `staging` into place as `finalDir`. The rename is the commit — there is no
 * check-then-act window: when `finalDir` already exists (another install got there
 * first, possibly a moment ago) a working install in it is kept and ours dropped; only
 * a version dir with no working executable is moved aside (into our own work dir,
 * removed with it) and the rename retried. A dir holding a working executable is never
 * deleted: another `slay` may be running it.
 */
function commitInstall(o: {
  staging: string
  finalDir: string
  aside: string
  rel: string
  ctx: BrowserEnv
  log: (line: string) => void
}): void {
  const theirs = path.join(o.finalDir, o.rel)
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(o.staging, o.finalDir)
      return
    } catch (err) {
      // Not "the target exists" (EEXIST / ENOTEMPTY; EPERM on Windows): a real error.
      if (!fs.existsSync(o.finalDir)) throw err
    }
    if (o.ctx.isExecutable(theirs)) {
      o.log(`Already installed by another run: ${theirs}`)
      return
    }
    if (attempt >= COMMIT_ATTEMPTS) {
      throw new BrowserInstallError(`Could not install into ${o.finalDir}: it keeps changing`)
    }
    // A broken leftover (no working executable): out of the way, atomically.
    const moved = `${o.aside}-${attempt}`
    try {
      fs.renameSync(o.finalDir, moved)
    } catch {
      continue // Gone or replaced meanwhile: the next attempt sees what is there now.
    }
    // Another install may have replaced the leftover between our check and our move:
    // then we just moved ITS working install. Put it back; if something else took the
    // place meanwhile, park it outside our work dir (the stale sweep removes it later)
    // rather than deleting a binary another `slay` may be running.
    if (o.ctx.isExecutable(path.join(moved, o.rel))) {
      try {
        fs.renameSync(moved, o.finalDir)
      } catch {
        try {
          fs.renameSync(
            moved,
            path.join(path.dirname(o.finalDir), `.install-kept-${randomBytes(4).toString('hex')}`)
          )
        } catch {
          // Nowhere to park it: it goes with our work dir.
        }
      }
    }
  }
}

/** Ensure a headless shell is in the cache; returns its executable path. */
export async function installHeadlessShell({
  ctx,
  fetchImpl = fetch,
  log,
  maxDownloadBytes = MAX_DOWNLOAD_BYTES
}: InstallOptions): Promise<string> {
  const existing = findCachedHeadlessShell(ctx)
  if (existing) return existing

  const cft = cftPlatformFor(ctx.platform, ctx.arch)
  if (!cft) throw new BrowserInstallError(noBuildMessage(ctx.platform, ctx.arch, null))

  const doc = await readJson(fetchImpl, CFT_VERSIONS_URL)
  const pick = selectHeadlessShellDownload(doc, cft)
  if (!pick) throw new BrowserInstallError(noBuildMessage(ctx.platform, ctx.arch, cft))

  const root = headlessShellCacheRoot(ctx)
  fs.mkdirSync(root, { recursive: true })
  sweepStaleInstalls(root)
  // Download and unpack inside one work dir, moved into place only when complete; on
  // any failure, exit or signal the work dir goes, so nothing half-installed stays.
  const work = path.join(root, `.install-${randomBytes(4).toString('hex')}`)
  fs.mkdirSync(work)
  const zipPath = path.join(work, 'download.zip')
  const staging = path.join(work, 'unpacked')
  const finalDir = path.join(root, pick.version)
  const rel = headlessShellBinaryRel(ctx.platform, cft)
  const removeWork = (): void => fs.rmSync(work, { recursive: true, force: true })
  const unhook = onExitOrSignal(removeWork)

  log(`Downloading Chromium headless shell ${pick.version} (${cft})…`)
  try {
    const res = await fetchOk(fetchImpl, pick.url)
    await pipeline(cappedBody(res, pick.url, maxDownloadBytes), fs.createWriteStream(zipPath))
    await extractZip(zipPath, staging)
    const bin = path.join(staging, rel)
    if (!fs.existsSync(bin)) {
      throw new BrowserInstallError(`Downloaded archive has no ${rel.split(path.sep).join('/')}`)
    }
    if (ctx.platform !== 'win32') fs.chmodSync(bin, 0o755)
    commitInstall({ staging, finalDir, aside: path.join(work, 'replaced'), rel, ctx, log })
  } catch (err) {
    throw err instanceof BrowserInstallError
      ? err
      : new BrowserInstallError(`Installing Chromium failed: ${(err as Error).message}`)
  } finally {
    unhook()
    removeWork()
  }
  const installed = path.join(finalDir, rel)
  log(`Installed: ${installed}`)
  return installed
}
