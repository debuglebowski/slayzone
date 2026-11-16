/** Main-owned copy helpers. Loading this module never loads or opens SQLite. */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { COMPACTION_WORKER_SOURCE } from './compaction-worker'

export interface TableInfo {
  name: string
  cols: string[]
  pk: string[]
  withoutRowid: boolean
}
export type Key = [string, ...unknown[]]
export interface CompactionWorkerInput {
  mode: 'build' | 'resume' | 'file'
  live: string
  out: string
  tables: TableInfo[]
  throttle: { batchBytes: number; syncBytes: number; pauseMs: number }
}
export type CompactionWorkerSpec = CompactionWorkerInput & {
  registration?: { release(): void }
  exit(): void
  progress(bytes: number): void
}
export type CompactionWorkerFactory = (spec: CompactionWorkerSpec) => WorkerHandle

/** better-sqlite3's entry, for the worker (loaded by path in an eval worker). */
function sqliteModulePath(): string {
  // The computer's CJS bundle: better-sqlite3 is external, resolved like the store's.
  if (typeof require === 'function') return require.resolve('better-sqlite3')
  // Unbundled ESM (tests, tsx): from the entry script, else the working directory.
  let lastError: unknown
  for (const from of [process.argv[1], join(process.cwd(), 'index.js')])
    if (from)
      try {
        return createRequire(from).resolve('better-sqlite3')
      } catch (error) {
        lastError = error
      }
  throw lastError
}

export interface WorkerHandle {
  ready: Promise<Array<{ name: string; sql: string }>>
  copy(tables: TableInfo[], keys: Key[]): Promise<void>
  finish(check: boolean): Promise<string>
  /** Inside a long native call (quick_check): it cannot stop before returning. */
  busyNative(): boolean
  /** Ends the thread; settles when it has exited. */
  terminate(): Promise<void>
}
/**
 * A compaction worker (`compaction-worker.ts`). `exit` runs when its thread really
 * ended (its copy is free then); `registration` (a live store's secondary-connection
 * entry) is released only after physical thread exit.
 */
export function startCompactionWorker(spec: CompactionWorkerSpec): WorkerHandle {
  const { mode, registration } = spec
  const on = spec
  let worker: Worker
  try {
    worker = new Worker(COMPACTION_WORKER_SOURCE, {
      eval: true,
      workerData: {
        modulePath: sqliteModulePath(),
        live: spec.live,
        out: spec.out,
        mode,
        tables: spec.tables,
        throttle: spec.throttle
      }
    })
  } catch (error) {
    // Constructor failure created no thread; release the reserved lifetime too.
    const errors: unknown[] = [error]
    for (const cleanup of [() => registration?.release(), () => on.exit()]) {
      try {
        cleanup()
      } catch (cleanupError) {
        errors.push(cleanupError)
      }
    }
    if (errors.length > 1)
      throw new AggregateError(errors, 'Copy worker startup cleanup failed', { cause: error })
    throw error
  }
  let waiting: { resolve(m: WorkerMessage): void; reject(e: Error): void } | null = null
  let failure: Error | null = null
  let ended = false
  let state: 'building' | 'idle' | 'copying' | 'finishing' = mode === 'resume' ? 'idle' : 'building'
  let markExited: () => void = () => undefined
  const exited = new Promise<void>((resolve) => {
    markExited = resolve
  })
  const end = () => {
    if (ended) return
    ended = true
    registration?.release()
  }
  const settle = (m: WorkerMessage | Error) => {
    const w = waiting
    waiting = null
    if (m instanceof Error) {
      failure = m
      w?.reject(m)
    } else w?.resolve(m)
  }
  worker.on('message', (m: WorkerMessage) => {
    if (m.t === 'progress') {
      on.progress(m.bytes)
      return
    }
    if (m.t === 'error') {
      settle(new Error(m.message))
    } else {
      settle(m)
    }
  })
  worker.on('error', (error) => {
    settle(error)
  })
  worker.on('exit', () => {
    try {
      end()
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)))
    }
    try {
      if (waiting) settle(new Error('The compaction worker stopped'))
      on.exit()
    } finally {
      markExited()
    }
  })
  const next = () =>
    failure
      ? Promise.reject(failure)
      : ended
        ? Promise.reject(new Error('The compaction worker stopped'))
        : new Promise<WorkerMessage>((resolve, reject) => {
            waiting = { resolve, reject }
          })
  const ready = next().then((m) => {
    state = 'idle'
    return m.t === 'ready' ? m.triggers : []
  })
  return {
    ready,
    async copy(tables, keys) {
      const reply = next()
      state = 'copying'
      worker.postMessage({ t: 'copy', tables, keys })
      await reply
      state = 'idle'
    },
    async finish(check) {
      const reply = next()
      state = 'finishing'
      worker.postMessage({ t: 'finish', check })
      const m = await reply
      await exited
      if (failure) throw failure
      return m.t === 'finished' ? m.check : 'no reply'
    },
    busyNative: () => state === 'finishing',
    terminate() {
      // Ends at the next JS boundary (between copy batches; quick_check runs to its
      // end). Only its read-only connection and its own copy are involved.
      void worker.terminate().catch(() => undefined)
      return exited
    }
  }
}

type WorkerMessage =
  | { t: 'ready'; triggers: Array<{ name: string; sql: string }> }
  | { t: 'copied' }
  | { t: 'progress'; bytes: number }
  | { t: 'finished'; check: string }
  | { t: 'error'; message: string }
