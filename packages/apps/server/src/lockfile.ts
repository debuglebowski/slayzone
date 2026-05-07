import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

export interface LockInfo {
  pid: number
  hostname: string
  host: string
  port: number
  mcpPort: number | null
  startedAt: string
  version: string
}

export interface AcquireOpts {
  dataRoot: string
  info: Omit<LockInfo, 'pid' | 'hostname' | 'startedAt'>
  /** Override hostname-mismatch refusal. */
  force?: boolean
}

export class LockHeldError extends Error {
  readonly existing: LockInfo
  constructor(existing: LockInfo) {
    super(
      `SlayZone server already running (pid=${existing.pid} on host=${existing.hostname} ` +
        `at ${existing.host}:${existing.port}). Stop it first or pass --lock-force ` +
        `(only safe if you're certain the holder is dead and on a different host).`,
    )
    this.name = 'LockHeldError'
    this.existing = existing
  }
}

export interface AcquiredLock {
  path: string
  info: LockInfo
  release(): void
}

const LOCK_FILENAME = 'server.lock'

function readLockFile(path: string): LockInfo | null {
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<LockInfo>
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.hostname === 'string' &&
      typeof parsed.host === 'string' &&
      typeof parsed.port === 'number' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.version === 'string'
    ) {
      return {
        pid: parsed.pid,
        hostname: parsed.hostname,
        host: parsed.host,
        port: parsed.port,
        mcpPort: typeof parsed.mcpPort === 'number' ? parsed.mcpPort : null,
        startedAt: parsed.startedAt,
        version: parsed.version,
      }
    }
  } catch {
    /* corrupt or unreadable — treat as stale */
  }
  return null
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM') return true
    return false
  }
}

function writeLockAtomic(path: string, info: LockInfo): void {
  const fd = openSync(path, 'wx')
  try {
    writeFileSync(fd, JSON.stringify(info, null, 2))
  } finally {
    closeSync(fd)
  }
}

export function acquireLock(opts: AcquireOpts): AcquiredLock {
  const path = join(opts.dataRoot, LOCK_FILENAME)
  const myHostname = hostname()
  const info: LockInfo = {
    pid: process.pid,
    hostname: myHostname,
    host: opts.info.host,
    port: opts.info.port,
    mcpPort: opts.info.mcpPort,
    startedAt: new Date().toISOString(),
    version: opts.info.version,
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeLockAtomic(path, info)
      return makeHandle(path, info)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err
      const existing = readLockFile(path)
      if (!existing) {
        try { unlinkSync(path) } catch { /* race */ }
        continue
      }
      if (existing.hostname !== myHostname) {
        if (!opts.force) throw new LockHeldError(existing)
        try { unlinkSync(path) } catch { /* race */ }
        continue
      }
      if (isProcessAlive(existing.pid)) throw new LockHeldError(existing)
      try { unlinkSync(path) } catch { /* race */ }
    }
  }
  throw new Error('Failed to acquire lockfile after retries')
}

function makeHandle(path: string, info: LockInfo): AcquiredLock {
  let released = false
  return {
    path,
    info,
    release(): void {
      if (released) return
      released = true
      try {
        if (existsSync(path)) {
          const current = readLockFile(path)
          if (current?.pid === info.pid) unlinkSync(path)
        }
      } catch {
        /* best-effort */
      }
    },
  }
}
