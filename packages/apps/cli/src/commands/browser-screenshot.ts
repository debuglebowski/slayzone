import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

/** What this CLI sends as `accept`: it writes the PNG itself, from the bytes. */
export const SCREENSHOT_ACCEPT = 'png-bytes'

/**
 * The image bytes in the hub's `/api/browser/screenshot` reply. A hub from before
 * bytes-not-paths answers with a path on ITS disk — useless here, so fail clearly.
 */
export function screenshotBytes(reply: {
  ok?: unknown
  pngBase64?: unknown
  path?: unknown
}): Uint8Array {
  if (typeof reply.pngBase64 !== 'string' || reply.pngBase64 === '') {
    throw new Error(
      'This hub is too old for this slay CLI: it did not send the screenshot image. Upgrade the hub (SlayZone app).'
    )
  }
  return new Uint8Array(Buffer.from(reply.pngBase64, 'base64'))
}

/**
 * Write the screenshot on this machine: `output` when given, else a fresh file in a
 * directory private to this user (0700, file 0600) under `base` (the temp dir, which
 * may be shared, e.g. /tmp on Linux). Screenshots older than an hour there are removed.
 */
export function writeScreenshot(
  bytes: Uint8Array,
  output: string | undefined,
  base: string = tmpdir()
): string {
  if (output) {
    writeFileSync(output, bytes)
    return output
  }
  const userDir = join(base, `slayzone-${userKey()}`)
  const dir = join(userDir, 'browser-screenshots')
  privateDir(userDir)
  privateDir(dir)
  const cutoff = Date.now() - 3_600_000
  for (const f of readdirSync(dir)) {
    const fp = join(dir, f)
    try {
      if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp)
    } catch {
      /* raced with another cleanup */
    }
  }
  const out = join(dir, `${randomUUID()}.png`)
  writeFileSync(out, bytes, { mode: 0o600, flag: 'wx' })
  return out
}

/** The current user, for the directory name: uid on POSIX, else the user name. */
function userKey(): string {
  const uid = process.getuid?.()
  return uid !== undefined ? String(uid) : userInfo().username.replace(/[^\w.-]/g, '_')
}

/**
 * Make `dir` a real directory owned by this user with mode 0700. One that already
 * exists must be ours and not a symlink (on a shared /tmp another user could have made
 * it first); a too-open one of ours is tightened.
 */
function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return
  const st = lstatSync(dir)
  const uid = process.getuid?.()
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
    throw new Error(
      `Refusing to write screenshots to ${dir}: it is not a directory owned by you. Remove it or pass --output.`
    )
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700)
}
