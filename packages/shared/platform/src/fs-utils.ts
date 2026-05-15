import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

/**
 * Write `content` to `filePath` atomically (temp file + rename), but only if
 * the existing file's bytes differ. Returns true if a write happened, false on no-op.
 *
 * - Creates parent dirs as needed.
 * - Applies `mode` on POSIX (silently ignored on win32 — chmod is a no-op there).
 * - If the target is a symlink, follows it once and writes through (does not
 *   replace the link itself).
 * - Atomic via `fs.rename` (POSIX) — concurrent writers tolerated.
 */
export async function writeFileIfChanged(
  filePath: string,
  content: string | Buffer,
  mode?: number,
): Promise<boolean> {
  const target = await resolveTarget(filePath)
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')

  const existing = await safeReadFile(target)
  if (existing && existing.equals(buf)) return false

  await fs.mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp.${crypto.randomBytes(6).toString('hex')}`
  await fs.writeFile(tmp, buf)
  if (mode != null && process.platform !== 'win32') {
    await fs.chmod(tmp, mode)
  }
  await fs.rename(tmp, target)
  return true
}

async function safeReadFile(p: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(p)
  } catch (err: unknown) {
    if (isENOENT(err)) return null
    throw err
  }
}

async function resolveTarget(p: string): Promise<string> {
  try {
    const stat = await fs.lstat(p)
    if (stat.isSymbolicLink()) return await fs.realpath(p)
  } catch (err: unknown) {
    if (!isENOENT(err)) throw err
  }
  return p
}

function isENOENT(err: unknown): boolean {
  return typeof err === 'object' && err != null && (err as { code?: string }).code === 'ENOENT'
}
