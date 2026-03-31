/**
 * CLI test harness — wraps better-sqlite3 in the SlayDb interface
 * and provides console/exit capture utilities.
 */
import type Database from 'better-sqlite3'
interface SlayDb {
  query<T extends object>(sql: string, params?: SqlParams): T[]
  run(sql: string, params?: SqlParams): void
  close(): void
}

type SqlParams = Record<string, string | number | bigint | null | Uint8Array>

/** Strip ':' prefix from param keys — node:sqlite uses ':name' keys, better-sqlite3 uses 'name' */
function adaptParams(params: SqlParams): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    out[k.startsWith(':') ? k.slice(1) : k] = v
  }
  return out
}

export function createSlayDbAdapter(db: Database.Database): SlayDb {
  return {
    query<T extends object>(sql: string, params: SqlParams = {}): T[] {
      return db.prepare(sql).all(adaptParams(params)) as T[]
    },
    run(sql: string, params: SqlParams = {}) {
      db.prepare(sql).run(adaptParams(params))
    },
    close() { /* no-op: harness manages lifecycle */ },
  }
}

class ExitError extends Error {
  constructor(public code: number) { super(`process.exit(${code})`) }
}

export function withExitCapture(fn: () => void): { exitCode: number | null } {
  const original = process.exit
  let exitCode: number | null = null
  process.exit = ((code: number) => { exitCode = code; throw new ExitError(code) }) as never
  try {
    fn()
    return { exitCode }
  } catch (e) {
    if (e instanceof ExitError) return { exitCode: e.code }
    throw e
  } finally {
    process.exit = original
  }
}

export async function withExitCaptureAsync(fn: () => Promise<void>): Promise<{ exitCode: number | null }> {
  const original = process.exit
  let exitCode: number | null = null
  process.exit = ((code: number) => { exitCode = code; throw new ExitError(code) }) as never
  try {
    await fn()
    return { exitCode }
  } catch (e) {
    if (e instanceof ExitError) return { exitCode: e.code }
    throw e
  } finally {
    process.exit = original
  }
}

export function captureOutput(fn: () => void): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '))
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '))
  try {
    fn()
  } finally {
    console.log = origLog
    console.error = origErr
  }
  return { stdout, stderr }
}

export async function captureOutputAsync(fn: () => Promise<void>): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '))
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '))
  try {
    await fn()
  } finally {
    console.log = origLog
    console.error = origErr
  }
  return { stdout, stderr }
}

/** Capture both output and exit in one call */
export function captureAll(fn: () => void): { stdout: string[]; stderr: string[]; exitCode: number | null } {
  const stdout: string[] = []
  const stderr: string[] = []
  const origLog = console.log
  const origErr = console.error
  const origExit = process.exit
  let exitCode: number | null = null
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '))
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '))
  process.exit = ((code: number) => { exitCode = code; throw new ExitError(code) }) as never
  try {
    fn()
  } catch (e) {
    if (!(e instanceof ExitError)) throw e
  } finally {
    console.log = origLog
    console.error = origErr
    process.exit = origExit
  }
  return { stdout, stderr, exitCode }
}

export async function captureAllAsync(fn: () => Promise<void>): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | null }> {
  const stdout: string[] = []
  const stderr: string[] = []
  const origLog = console.log
  const origErr = console.error
  const origExit = process.exit
  let exitCode: number | null = null
  console.log = (...args: unknown[]) => stdout.push(args.map(String).join(' '))
  console.error = (...args: unknown[]) => stderr.push(args.map(String).join(' '))
  process.exit = ((code: number) => { exitCode = code; throw new ExitError(code) }) as never
  try {
    await fn()
  } catch (e) {
    if (!(e instanceof ExitError)) throw e
  } finally {
    console.log = origLog
    console.error = origErr
    process.exit = origExit
  }
  return { stdout, stderr, exitCode }
}
