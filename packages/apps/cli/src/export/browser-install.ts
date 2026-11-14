/**
 * `--install-browser`: download Chrome for Testing's `chrome-headless-shell` (Stable
 * channel, this OS/arch) into the per-user cache, once. Discovery step 3
 * (`findCachedHeadlessShell`) finds it from then on, so the flag is not needed again.
 *
 * The install is atomic: the zip lands in a temp file and unpacks into a
 * `<version>.partial-*` sibling that is renamed into place only once the binary is
 * there and executable. Discovery only looks at plain version-named dirs, so a crash
 * mid-install leaves nothing it would pick up.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
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
  return { version, url: hit.url }
}

function noBuildMessage(platform: string, arch: string, cft: string | null): string {
  const what = cft ?? `${platform}/${arch}`
  return (
    `Chrome for Testing publishes no headless Chromium for ${what}.\n` +
    'Install Chromium with your package manager (e.g. `sudo apt-get install chromium`),\n' +
    'or pass --browser <path> to a Chrome/Chromium/Edge executable.'
  )
}

async function fetchOk(fetchImpl: typeof fetch, url: string): Promise<Response> {
  let res: Response
  try {
    res = await fetchImpl(url)
  } catch (err) {
    throw new BrowserInstallError(`Download failed (${url}): ${(err as Error).message}`)
  }
  if (!res.ok) throw new BrowserInstallError(`Download failed (${url}): HTTP ${res.status}`)
  return res
}

export interface InstallOptions {
  ctx: BrowserEnv
  fetchImpl?: typeof fetch
  /** Progress lines (stderr in the CLI: stdout carries the output path). */
  log: (line: string) => void
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

/** Ensure a headless shell is in the cache; returns its executable path. */
export async function installHeadlessShell({
  ctx,
  fetchImpl = fetch,
  log
}: InstallOptions): Promise<string> {
  const existing = findCachedHeadlessShell(ctx)
  if (existing) return existing

  const cft = cftPlatformFor(ctx.platform, ctx.arch)
  if (!cft) throw new BrowserInstallError(noBuildMessage(ctx.platform, ctx.arch, null))

  const doc = (await (await fetchOk(fetchImpl, CFT_VERSIONS_URL)).json()) as unknown
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
    if (!res.body) throw new BrowserInstallError(`Download failed (${pick.url}): empty body`)
    await pipeline(
      Readable.fromWeb(res.body as unknown as StreamWebReadable),
      fs.createWriteStream(zipPath)
    )
    await extractZip(zipPath, staging)
    const bin = path.join(staging, rel)
    if (!fs.existsSync(bin)) {
      throw new BrowserInstallError(`Downloaded archive has no ${rel.split(path.sep).join('/')}`)
    }
    if (ctx.platform !== 'win32') fs.chmodSync(bin, 0o755)
    // Another install (a parallel agent) may have finished this version meanwhile:
    // keep it — never delete a working install another `slay` may be using.
    if (ctx.isExecutable(path.join(finalDir, rel))) {
      log(`Already installed by another run: ${path.join(finalDir, rel)}`)
    } else {
      fs.rmSync(finalDir, { recursive: true, force: true })
      fs.renameSync(staging, finalDir)
    }
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
