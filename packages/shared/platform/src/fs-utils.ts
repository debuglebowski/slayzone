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
 * - Atomic via `fs.rename` (POSIX): no reader ever sees a torn file.
 *
 * NOT safe for read-modify-write. This sees only the FINAL bytes, so it cannot
 * tell that the caller computed them from a baseline another writer has since
 * replaced — the rename then silently discards that writer's work. Fine for
 * content derived from nothing but its inputs (a bundled script written verbatim);
 * for anything MERGED into existing file contents, use {@link updateFileAtomically},
 * which owns the whole cycle and can re-run the merge.
 */
export async function writeFileIfChanged(
  filePath: string,
  content: string | Buffer,
  mode?: number
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

/**
 * Merge new content into `filePath` atomically, re-running the merge if the file
 * changed underneath us. Returns true if a write happened.
 *
 * WHY THIS EXISTS, AND WHY `writeFileIfChanged` IS NOT ENOUGH.
 * `writeFileIfChanged` only ever sees the FINAL bytes, so a caller doing the
 * usual read → merge → write has already computed those bytes from a baseline
 * that another process may have replaced in the meantime. The rename is atomic,
 * so no reader sees a torn file — but the LOST UPDATE is invisible: the second
 * writer's rename silently discards the first writer's merge.
 *
 * That was accidentally harmless while exactly one process type (the desktop app)
 * ever wrote these files: identical version + identical inputs produce identical
 * bytes, so even a race converged. It stops being harmless as soon as a second
 * installer exists on the same machine (a standalone runner), because the two can
 * be on DIFFERENT builds — and then the stale one's write is not equal, it is a
 * downgrade. Crucially that includes a version GATE: an installer that reads the
 * on-disk version, decides "mine is newer", and writes, has evaluated its own gate
 * against a stale read. This is the shape of the incident that stripped
 * `slaySessionId` from `notify.sh` and broke warm-pool session tracking.
 *
 * The fix is to make the whole cycle one primitive so the baseline the merge saw
 * is the baseline that gets replaced:
 *
 *   1. read current bytes (the BASELINE, handed to `merge`)
 *   2. `merge(baseline)` → new bytes, or `null` to decline (a gate saying "mine is
 *      not newer" — declining is a real outcome, not an error)
 *   3. re-read immediately before the rename; if the bytes are no longer the
 *      baseline, someone else committed first — discard our temp file and re-run
 *      the merge against the fresh state
 *
 * Step 3 is what makes a gate sound: on a retry the merge re-evaluates against
 * what is ACTUALLY on disk, so a stale writer that would have downgraded now sees
 * the newer version and declines. The fresher content wins regardless of which
 * writer finishes first.
 *
 * TWO MECHANISMS, ON PURPOSE. The cycle runs under an exclusive lock file, and
 * still re-checks the bytes before renaming. The lock is what actually prevents a
 * lost update between cooperating writers — a bare re-check cannot, because both
 * writers can re-read before either renames, and then both believe they are
 * uncontended. The re-check is not therefore redundant: it is the only thing that
 * catches a writer which does NOT take the lock, and during a rollout that writer
 * definitely exists (an older, already-installed build). Lock for the peers we
 * know about, verify for the ones we do not.
 */
export async function updateFileAtomically(
  filePath: string,
  merge: (current: Buffer | null) => Promise<string | Buffer | null> | string | Buffer | null,
  opts: { mode?: number; retries?: number } = {}
): Promise<boolean> {
  const { mode, retries = 5 } = opts
  const target = await resolveTarget(filePath)
  await fs.mkdir(path.dirname(target), { recursive: true })

  const release = await acquireLock(`${target}.lock`)
  try {
    for (let attempt = 0; ; attempt++) {
      const baseline = await safeReadFile(target)
      const merged = await merge(baseline)

      // `null` = the caller's gate declined. Not a failure, and NOT an empty write.
      if (merged == null) return false

      const buf = Buffer.isBuffer(merged) ? merged : Buffer.from(merged, 'utf8')
      if (baseline && baseline.equals(buf)) return false

      const tmp = `${target}.tmp.${crypto.randomBytes(6).toString('hex')}`
      await fs.writeFile(tmp, buf)
      if (mode != null && process.platform !== 'win32') {
        await fs.chmod(tmp, mode)
      }

      // Still the file `merge` was handed? Only an unlocked writer can trip this.
      if (sameBytes(baseline, await safeReadFile(target))) {
        await fs.rename(tmp, target)
        return true
      }

      // Someone committed first. Drop our temp file rather than leave it to
      // accumulate in the user's ~/.claude, and re-merge against their result.
      await fs.rm(tmp, { force: true })
      if (attempt >= retries) {
        throw new Error(
          `[fs-utils] updateFileAtomically: ${target} kept changing underneath ` +
            `${retries + 1} merge attempts — giving up rather than writing a stale merge`
        )
      }
      await sleep(2 ** attempt + Math.floor(Math.random() * 5))
    }
  } finally {
    await release()
  }
}

/** How long before a lock is presumed abandoned by a process that died holding it. */
const LOCK_STALE_MS = 10_000
/** Cap on waiting for a peer. Bounded because this runs on app boot and agent
 *  spawn — a hook install may fail loudly, but it must never hang either. */
const LOCK_TIMEOUT_MS = 5_000

/**
 * Take an exclusive lock via `open(…, 'wx')` — O_CREAT|O_EXCL, atomic create-
 * if-absent, so exactly one caller wins even across processes.
 *
 * A crashed holder would otherwise wedge every future install, so a lock older
 * than {@link LOCK_STALE_MS} is stolen. Two callers can in principle steal the
 * same stale lock; that returns the pair to the unlocked behaviour the byte
 * re-check already covers, which is why stealing is safe to keep simple.
 */
async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx')
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`)
      await handle.close()
      return async () => {
        await fs.rm(lockPath, { force: true })
      }
    } catch (err: unknown) {
      if (!isCode(err, 'EEXIST')) throw err
      const age = await lockAgeMs(lockPath)
      if (age === null) continue // holder released between our open and our stat
      if (age > LOCK_STALE_MS) {
        await fs.rm(lockPath, { force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw new Error(
          `[fs-utils] timed out after ${LOCK_TIMEOUT_MS}ms waiting for ${lockPath}`
        )
      }
      await sleep(5 + Math.floor(Math.random() * 10))
    }
  }
}

async function lockAgeMs(lockPath: string): Promise<number | null> {
  try {
    return Date.now() - (await fs.stat(lockPath)).mtimeMs
  } catch (err: unknown) {
    if (isCode(err, 'ENOENT')) return null
    throw err
  }
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b
  return a.equals(b)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  return isCode(err, 'ENOENT')
}

function isCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err != null && (err as { code?: string }).code === code
}
