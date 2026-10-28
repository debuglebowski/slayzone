// Dev-only (`vite serve`) React Compiler transform with an on-disk cache and a
// worker_threads pool.
//
// Why: the compiler pass (@rolldown/plugin-babel + plugin-react's
// reactCompilerPreset, see @slayzone/react-compiler-config) runs Babel on Vite's
// single main thread with only an in-memory cache, so every `pnpm dev` cold
// start re-compiles the whole renderer graph (~13s CPU for the boot graph,
// TaskDetailPage alone ~1.8s). This plugin:
//   - keys each module by sha256(toolchain versions + worker source + id + code)
//     and stores the compiled code under <cacheDir>/react-compiler — an
//     unchanged file is a disk read on the next boot;
//   - compiles misses in a small worker pool, so cold boots use several cores.
//
// Output is byte-identical to the stock compiler pass (see
// react-compiler-worker.mjs), and the same modules are compiled: plugin-react's
// include/exclude plus the preset's code filter. When this plugin is active,
// plugin-react and the compiler plugin are configured to transform nothing (their
// `include` matches no id) but still provide the refresh preamble + optimizeDeps
// entries (react/compiler-runtime).
//
// Fast refresh is NOT applied: this mode is only used while dev runs React's
// production build, whose react-dom has no `scheduleRefresh`, so React Refresh
// can never apply an update there. Without the refresh wrapper no module
// self-accepts, so a source edit propagates to Vite's full page reload (the
// HMR channel itself is untouched). Real dev React (SLAYZONE_REACT_DEV=1 /
// SLAYZONE_PROFILE=1) keeps the stock plugin-react path with fast refresh.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { Plugin } from 'vite'
import {
  REACT_COMPILER_CODE_FILTER,
  REACT_COMPILER_EXCLUDE,
  REACT_COMPILER_INCLUDE
} from '@slayzone/react-compiler-config'

const WORKER_PATH = fileURLToPath(new URL('./react-compiler-worker.mjs', import.meta.url))

const INCLUDE_RE = REACT_COMPILER_INCLUDE
const EXCLUDE_RE = REACT_COMPILER_EXCLUDE

/** Entries untouched this long are swept at server start. Hits refresh mtime daily. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000
/** Extra workers (beyond the first) exit after this long idle; the first stays warm for edits. */
const WORKER_IDLE_MS = 30_000

/** A regex that matches no module id — hands the stock compiler pass to this plugin. */
export const NO_MODULE_RE = /(?!)/

interface WorkerReply {
  seq: number
  code?: string
  error?: { message: string; [k: string]: unknown }
}

interface PoolWorker {
  worker: Worker
  busy: boolean
  /** seq of the job in flight while busy. */
  job?: number
  idleTimer?: NodeJS.Timeout
}

interface Job {
  seq: number
  code: string
  id: string
  root: string
  resolve: (code: string) => void
  reject: (err: Error) => void
}

class CompilerPool {
  private workers: PoolWorker[] = []
  private queue: Job[] = []
  private pending = new Map<number, Job>()
  private seq = 0
  /** Worker deaths since the last successful reply (startup-crash loop guard). */
  private deaths = 0
  private readonly size: number

  constructor(size: number) {
    this.size = size
  }

  /** Start the first worker so Babel is loaded before the first request. */
  warm(): void {
    if (this.workers.length === 0) this.spawn()
  }

  run(code: string, id: string, root: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.queue.push({ seq: ++this.seq, code, id, root, resolve, reject })
      this.pump()
    })
  }

  /**
   * Terminate workers and fail in-flight jobs. Not terminal: Vite reuses the
   * plugin instance across a dev-server restart, so a later run() respawns.
   */
  close(): void {
    for (const w of this.workers) void w.worker.terminate()
    this.workers = []
    const err = new Error('react-compiler pool closed')
    for (const job of [...this.queue, ...this.pending.values()]) job.reject(err)
    this.queue = []
    this.pending.clear()
  }

  private spawn(): PoolWorker {
    const pw: PoolWorker = {
      worker: new Worker(WORKER_PATH, { workerData: { role: 'react-compiler' } }),
      busy: false
    }
    pw.worker.unref()
    pw.worker.on('message', (msg: WorkerReply) => this.onReply(pw, msg))
    pw.worker.on('error', (err) => this.onWorkerDeath(pw, err))
    pw.worker.on('exit', (code) => {
      if (this.workers.includes(pw)) this.onWorkerDeath(pw, new Error(`worker exited (${code})`))
    })
    this.workers.push(pw)
    return pw
  }

  private pump(): void {
    while (this.queue.length > 0) {
      let pw = this.workers.find((w) => !w.busy)
      if (!pw && this.workers.length < this.size) pw = this.spawn()
      if (!pw) return
      const job = this.queue.shift()!
      pw.busy = true
      clearTimeout(pw.idleTimer)
      pw.idleTimer = undefined
      this.pending.set(job.seq, job)
      pw.job = job.seq
      pw.worker.ref()
      pw.worker.postMessage({ seq: job.seq, code: job.code, id: job.id, root: job.root })
    }
  }

  private onReply(pw: PoolWorker, msg: WorkerReply): void {
    const job = this.pending.get(msg.seq)
    this.pending.delete(msg.seq)
    pw.busy = false
    pw.worker.unref()
    this.deaths = 0
    if (job) {
      if (msg.error) job.reject(Object.assign(new Error(msg.error.message), msg.error))
      else job.resolve(msg.code ?? job.code)
    }
    this.scheduleIdleExit(pw)
    this.pump()
  }

  private scheduleIdleExit(pw: PoolWorker): void {
    if (this.workers[0] === pw) return
    pw.idleTimer = setTimeout(() => {
      if (pw.busy) return
      this.workers = this.workers.filter((w) => w !== pw)
      void pw.worker.terminate()
    }, WORKER_IDLE_MS)
    pw.idleTimer.unref()
  }

  private onWorkerDeath(pw: PoolWorker, err: Error): void {
    this.workers = this.workers.filter((w) => w !== pw)
    clearTimeout(pw.idleTimer)
    if (pw.busy && pw.job !== undefined) {
      const job = this.pending.get(pw.job)
      this.pending.delete(pw.job)
      job?.reject(err)
    }
    // A worker that keeps dying before answering (e.g. Babel fails to load)
    // must not respawn forever: fail the queue with the cause instead.
    if (++this.deaths >= 3 && this.workers.length === 0) {
      for (const job of this.queue) job.reject(err)
      this.queue = []
      this.deaths = 0
      return
    }
    this.pump()
  }
}

function toolchainKey(): string {
  // Resolve from the app package, like the worker does.
  const appRequire = createRequire(new URL('../package.json', import.meta.url))
  // A package whose `exports` hides package.json (@vitejs/plugin-react): walk up
  // from its resolved entry to its own manifest.
  const versionOf = (name: string): string => {
    try {
      return (appRequire(`${name}/package.json`) as { version: string }).version
    } catch {
      let dir = dirname(appRequire.resolve(name))
      for (;;) {
        const file = join(dir, 'package.json')
        if (existsSync(file)) {
          const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
            name?: string
            version: string
          }
          if (manifest.name === name) return manifest.version
        }
        const up = dirname(dir)
        if (up === dir) throw new Error(`no package.json for ${name}`)
        dir = up
      }
    }
  }
  return JSON.stringify({
    tool: [
      '@babel/core',
      '@babel/parser',
      '@babel/generator',
      '@babel/traverse',
      'babel-plugin-react-compiler',
      // reactCompilerPreset (the compiler options the worker loads) lives here.
      '@vitejs/plugin-react'
    ].map((n) => `${n}@${versionOf(n)}`),
    // Option changes in the worker invalidate every entry.
    worker: createHash('sha256').update(readFileSync(WORKER_PATH)).digest('hex')
  })
}

async function sweep(dir: string): Promise<void> {
  const now = Date.now()
  let shards: string[]
  try {
    shards = await readdir(dir)
  } catch {
    return
  }
  for (const shard of shards) {
    const shardDir = join(dir, shard)
    let files: string[]
    try {
      files = await readdir(shardDir)
    } catch {
      continue
    }
    for (const f of files) {
      const p = join(shardDir, f)
      const s = await stat(p).catch(() => null)
      if (s && now - s.mtimeMs > MAX_AGE_MS) await rm(p, { force: true })
    }
  }
}

export interface ReactCompilerCacheStats {
  hits: number
  misses: number
  missMs: number
}

/**
 * @param stats optional sink for hit/miss counters (bench + diagnostics).
 */
export function reactCompilerCachePlugin(stats?: ReactCompilerCacheStats): Plugin {
  let root = process.cwd()
  let cacheDir = ''
  let baseKey = ''
  const size = Math.max(1, Math.min(availableParallelism() - 2, 6))
  const pool = new CompilerPool(size)

  return {
    name: 'slayzone:react-compiler-cache',
    apply: 'serve',
    enforce: 'pre',
    configResolved(config) {
      root = config.root
      cacheDir = join(config.cacheDir, 'react-compiler')
      baseKey = toolchainKey()
    },
    configureServer() {
      pool.warm()
      const t = setTimeout(() => void sweep(cacheDir), 60_000)
      t.unref()
    },
    buildEnd() {
      pool.close()
    },
    transform: {
      filter: {
        id: { include: INCLUDE_RE, exclude: EXCLUDE_RE },
        code: REACT_COMPILER_CODE_FILTER
      },
      async handler(code, id, options) {
        const [filepath] = id.split('?')
        // Same gates as the compiler preset: never SSR modules, and only modules
        // whose code can hold a component or hook.
        if (
          options?.ssr ||
          !INCLUDE_RE.test(filepath) ||
          EXCLUDE_RE.test(filepath) ||
          !REACT_COMPILER_CODE_FILTER.test(code)
        )
          return
        const key = createHash('sha256')
          .update(baseKey)
          .update('\0')
          .update(root)
          .update('\0')
          .update(id)
          .update('\0')
          .update(code)
          .digest('hex')
        const file = join(cacheDir, key.slice(0, 2), `${key}.js`)
        const cached = await readFile(file, 'utf8').catch(() => null)
        if (cached !== null) {
          if (stats) stats.hits++
          void stat(file)
            .then((s) => {
              if (Date.now() - s.mtimeMs > TOUCH_AFTER_MS) {
                const now = new Date()
                return utimes(file, now, now)
              }
              return undefined
            })
            .catch(() => {
              // Best-effort LRU touch: an untouched entry only ages out sooner.
            })
          return { code: cached, map: { mappings: '' } }
        }
        const t0 = performance.now()
        const out = await pool.run(code, id, root)
        if (stats) {
          stats.misses++
          stats.missMs += performance.now() - t0
        }
        // Atomic publish: concurrent dev servers / crashes never leave a torn entry.
        const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
        void mkdir(join(cacheDir, key.slice(0, 2)), { recursive: true })
          .then(() => writeFile(tmp, out))
          .then(() => rename(tmp, file))
          .catch(() =>
            rm(tmp, { force: true }).catch(() => {
              // Best-effort: a stray .tmp is harmless; the next miss recompiles.
            })
          )
        return { code: out, map: { mappings: '' } }
      }
    }
  }
}
