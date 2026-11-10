/**
 * Per-item isolation for every pass that walks a list of independent items
 * (boot scrubs, cleanups, erasure, retention, sync deliveries). One bad item must
 * fail on its own: a pass that aborts on its first bad item leaves EVERY later
 * item stuck, for a problem in one.
 *
 * - A failure is recorded in a fault ledger (`item_faults`, one table on the hub
 *   and one on each computer) and shown to the user ("Needs attention").
 * - Transient failures retry with backoff; structural ones (unparsable, unsafe,
 *   schema-invalid) stay quarantined until the item changes (its fingerprint).
 * - Only a failure that no item could survive is fatal and stops the pass: the
 *   caller decides which (hub: computer unreachable; computer: disk/DB broken).
 */
import { isUnsafePathError } from './safe-path'

export type FaultKind = 'transient' | 'structural'

/** Thrown by an item to say "this item's own data is invalid": quarantine it. */
export class StructuralFaultError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StructuralFaultError'
  }
}

/** Unparsable, schema-invalid or unsafe data does not heal by retrying. */
export function classifyFault(error: unknown): FaultKind {
  if (!(error instanceof Error)) return 'transient'
  if (
    error instanceof SyntaxError ||
    error.name === 'SyntaxError' ||
    error.name === 'ZodError' ||
    error.name === 'StructuralFaultError' ||
    isUnsafePathError(error)
  )
    return 'structural'
  return 'transient'
}

const STORAGE_FATAL_CODES = new Set([
  'SQLITE_CORRUPT',
  'SQLITE_NOTADB',
  'SQLITE_FULL',
  'SQLITE_IOERR',
  'SQLITE_READONLY',
  'SQLITE_CANTOPEN',
  'ENOSPC',
  'EROFS',
  'EIO',
  'EDQUOT'
])

/**
 * The machine's own disk or database is broken: no later item can succeed, so
 * the computer's passes stop instead of faulting every item.
 */
export function isStorageFatal(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return false
  return STORAGE_FATAL_CODES.has(code) || code.startsWith('SQLITE_IOERR')
}

const ITEM_DAMAGE_CODES = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB'])

/**
 * Errors raised while reading ONE item's own database file (a backup snapshot,
 * a restored archive): a corrupt or non-database file is that item's structural
 * damage, not the machine's, so it must not be mistaken for {@link isStorageFatal}.
 * Other errors (disk full, I/O) are returned unchanged.
 */
export function asItemDamage(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && ITEM_DAMAGE_CODES.has(code))
    return new StructuralFaultError((error as Error).message, { cause: error })
  return toError(error)
}

/** The content-erasure fence refused a write: that task is gone, so is its fault. */
function isErasureFence(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Content was permanently erased')
}

export function toError(raw: unknown): Error {
  return raw instanceof Error ? raw : new Error(String(raw))
}

// ── Fault ledger ─────────────────────────────────────────────────────────────

/** DDL shared (byte-equal, asserted by tests) by hub migration v203 and the computer's chat storage. */
export const ITEM_FAULTS_DDL = `CREATE TABLE IF NOT EXISTS item_faults (
  origin TEXT NOT NULL CHECK (origin IN ('hub','computer')),
  computer_id TEXT NOT NULL DEFAULT '',
  pass TEXT NOT NULL,
  item_key TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('transient','structural')),
  fingerprint TEXT,
  message TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  next_retry_at INTEGER,
  PRIMARY KEY (origin, computer_id, pass, item_key)
)`

export interface ItemFaultRow {
  origin: 'hub' | 'computer'
  computer_id: string
  pass: string
  item_key: string
  task_id: string | null
  kind: FaultKind
  fingerprint: string | null
  message: string
  attempts: number
  first_at: number
  last_at: number
  next_retry_at: number | null
}

export interface FaultInput {
  pass: string
  itemKey: string
  taskId?: string | null
  fingerprint?: string | null
  kind: FaultKind
  error: Error
}

/** Ledger scope: hub-side faults per computer (or '' for the hub itself); a computer's own faults. */
export interface FaultScope {
  origin: 'hub' | 'computer'
  computerId?: string
}

export const FAULT_BACKOFF_BASE_MS = 5_000
export const FAULT_BACKOFF_MAX_MS = 60 * 60_000

/** Transient backoff: 5 s, 10 s, 20 s … capped at one hour. */
export function faultBackoffMs(attempts: number): number {
  return Math.min(FAULT_BACKOFF_MAX_MS, FAULT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

/** Whether a pass may run an item now, given its fault row (pure). */
export function faultAllowsRun(
  row: Pick<ItemFaultRow, 'kind' | 'fingerprint' | 'next_retry_at'> | undefined,
  fingerprint: string | null | undefined,
  now: number
): boolean {
  if (!row) return true
  if (row.kind === 'structural') {
    // Quarantined until the item changes. Unknown fingerprints never match, so
    // an item we cannot fingerprint is retried on its backoff instead.
    if (row.fingerprint != null && fingerprint != null) return row.fingerprint !== fingerprint
    return row.next_retry_at == null || now >= row.next_retry_at
  }
  return row.next_retry_at == null || now >= row.next_retry_at
}

function nextFault(
  scope: FaultScope,
  prev: Pick<ItemFaultRow, 'attempts' | 'first_at'> | undefined,
  input: FaultInput,
  now: number
): ItemFaultRow {
  const attempts = (prev?.attempts ?? 0) + 1
  const fingerprint = input.fingerprint ?? null
  return {
    origin: scope.origin,
    computer_id: scope.computerId ?? '',
    pass: input.pass,
    item_key: input.itemKey,
    task_id: input.taskId ?? null,
    kind: input.kind,
    fingerprint,
    message: (input.error.message || input.error.name).slice(0, 2_000),
    attempts,
    first_at: prev?.first_at ?? now,
    last_at: now,
    // A structural fault with a fingerprint waits for a change; without one it backs off.
    next_retry_at:
      input.kind === 'structural' && fingerprint != null ? null : now + faultBackoffMs(attempts)
  }
}

const SELECT_ONE = `SELECT kind, fingerprint, next_retry_at, attempts, first_at FROM item_faults
  WHERE origin = ? AND computer_id = ? AND pass = ? AND item_key = ?`
const UPSERT = `INSERT INTO item_faults (origin, computer_id, pass, item_key, task_id, kind,
    fingerprint, message, attempts, first_at, last_at, next_retry_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (origin, computer_id, pass, item_key) DO UPDATE SET task_id = excluded.task_id,
    kind = excluded.kind, fingerprint = excluded.fingerprint, message = excluded.message,
    attempts = excluded.attempts, last_at = excluded.last_at, next_retry_at = excluded.next_retry_at`
const DELETE_ONE = `DELETE FROM item_faults WHERE origin = ? AND computer_id = ? AND pass = ? AND item_key = ?`

const rowParams = (r: ItemFaultRow) => [
  r.origin,
  r.computer_id,
  r.pass,
  r.item_key,
  r.task_id,
  r.kind,
  r.fingerprint,
  r.message,
  r.attempts,
  r.first_at,
  r.last_at,
  r.next_retry_at
]

type GateRow = Pick<
  ItemFaultRow,
  'kind' | 'fingerprint' | 'next_retry_at' | 'attempts' | 'first_at'
>

export interface SyncFaultLedger {
  allows(
    pass: string,
    itemKey: string,
    fingerprint: string | null | undefined,
    now: number
  ): boolean
  record(input: FaultInput, now: number): void
  clear(pass: string, itemKey: string): void
}

export interface FaultLedger {
  allows(
    pass: string,
    itemKey: string,
    fingerprint: string | null | undefined,
    now: number
  ): boolean | Promise<boolean>
  record(input: FaultInput, now: number): void | Promise<void>
  clear(pass: string, itemKey: string): void | Promise<void>
}

interface SyncStatement {
  get(...params: unknown[]): unknown
  run(...params: unknown[]): unknown
}

/** Ledger over a synchronous better-sqlite3 handle (computer storage, hub worker txns). */
export function createSyncFaultLedger(
  db: { prepare(sql: string): SyncStatement },
  scope: FaultScope
): SyncFaultLedger {
  const key = (pass: string, item: string) => [scope.origin, scope.computerId ?? '', pass, item]
  return {
    allows(pass, itemKey, fingerprint, now) {
      const row = db.prepare(SELECT_ONE).get(...key(pass, itemKey)) as GateRow | undefined
      return faultAllowsRun(row, fingerprint, now)
    },
    record(input, now) {
      const prev = db.prepare(SELECT_ONE).get(...key(input.pass, input.itemKey)) as
        | GateRow
        | undefined
      try {
        db.prepare(UPSERT).run(...rowParams(nextFault(scope, prev, input, now)))
      } catch (error) {
        if (!isErasureFence(error)) throw error
      }
    },
    clear(pass, itemKey) {
      db.prepare(DELETE_ONE).run(...key(pass, itemKey))
    }
  }
}

interface AsyncSql {
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>
  run(sql: string, params?: unknown[]): Promise<unknown>
}

/** Ledger over the hub's async database proxy. */
export function createAsyncFaultLedger(db: AsyncSql, scope: FaultScope): FaultLedger {
  const key = (pass: string, item: string) => [scope.origin, scope.computerId ?? '', pass, item]
  return {
    async allows(pass, itemKey, fingerprint, now) {
      return faultAllowsRun(await db.get<GateRow>(SELECT_ONE, key(pass, itemKey)), fingerprint, now)
    },
    async record(input, now) {
      const prev = await db.get<GateRow>(SELECT_ONE, key(input.pass, input.itemKey))
      try {
        await db.run(UPSERT, rowParams(nextFault(scope, prev, input, now)))
      } catch (error) {
        if (!isErasureFence(error)) throw error
      }
    },
    async clear(pass, itemKey) {
      await db.run(DELETE_ONE, key(pass, itemKey))
    }
  }
}

// ── The loop ─────────────────────────────────────────────────────────────────

export interface IsolationOptions<T> {
  /** Stable pass name, e.g. 'computer.cleanup-deleted-tasks'. Shown to the user. */
  pass: string
  /** Stable item identity within the pass. */
  key: (item: T) => string
  taskId?: (item: T) => string | null | undefined
  /** Changes when the item's data changes (file size+mtime, row hash). Lifts a quarantine. */
  fingerprint?: (item: T) => string | null | undefined
  /** A failure no other item can survive: rethrown, ends the pass. */
  isFatal?: (error: unknown) => boolean
  /** Override kind detection (default {@link classifyFault}). */
  classify?: (error: unknown) => FaultKind
  /** Without a ledger failures are only logged and returned. */
  ledger?: FaultLedger
  /** Skip the ledger gate (an explicit user Retry, or erasure that must try everything). */
  ignoreGate?: boolean
  log?: (message: string, error: Error) => void
  now?: () => number
}

export interface ItemFailure<T> {
  item: T
  key: string
  kind: FaultKind
  error: Error
}

export interface IsolationReport<T> {
  ok: number
  /** Held back by the ledger (backing off or quarantined and unchanged). */
  skipped: T[]
  failed: ItemFailure<T>[]
}

const defaultLog = (message: string, error: Error) => console.error(message, error)

function safeFingerprint<T>(opts: IsolationOptions<T>, item: T): string | null {
  try {
    return opts.fingerprint?.(item) ?? null
  } catch {
    return null
  }
}

function failureInput<T>(
  opts: IsolationOptions<T>,
  item: T,
  itemKey: string,
  fingerprint: string | null,
  error: Error
): FaultInput {
  return {
    pass: opts.pass,
    itemKey,
    taskId: opts.taskId?.(item) ?? null,
    fingerprint,
    kind: (opts.classify ?? classifyFault)(error),
    error
  }
}

/** Runs `run` for each item; one item's failure is recorded and the pass continues. */
export async function forEachIsolated<T>(
  items: Iterable<T> | AsyncIterable<T>,
  opts: IsolationOptions<T>,
  run: (item: T) => unknown
): Promise<IsolationReport<T>> {
  const report: IsolationReport<T> = { ok: 0, skipped: [], failed: [] }
  const now = opts.now ?? Date.now
  const log = opts.log ?? defaultLog
  for await (const item of items) {
    const itemKey = opts.key(item)
    const fingerprint = safeFingerprint(opts, item)
    if (
      opts.ledger &&
      !opts.ignoreGate &&
      !(await opts.ledger.allows(opts.pass, itemKey, fingerprint, now()))
    ) {
      report.skipped.push(item)
      continue
    }
    try {
      await run(item)
    } catch (raw) {
      if (opts.isFatal?.(raw)) throw raw
      const error = toError(raw)
      const input = failureInput(opts, item, itemKey, fingerprint, error)
      log(
        `[${opts.pass}] ${itemKey} failed (${input.kind}); continuing with the other items:`,
        error
      )
      report.failed.push({ item, key: itemKey, kind: input.kind, error })
      await opts.ledger?.record(input, now())
      continue
    }
    report.ok++
    await opts.ledger?.clear(opts.pass, itemKey)
  }
  return report
}

export interface SyncIsolationOptions<T> extends Omit<IsolationOptions<T>, 'ledger'> {
  ledger?: SyncFaultLedger
}

/** Synchronous {@link forEachIsolated}, for boot scrubs and loops inside a transaction. */
export function forEachIsolatedSync<T>(
  items: Iterable<T>,
  opts: SyncIsolationOptions<T>,
  run: (item: T) => void
): IsolationReport<T> {
  const report: IsolationReport<T> = { ok: 0, skipped: [], failed: [] }
  const now = opts.now ?? Date.now
  const log = opts.log ?? defaultLog
  for (const item of items) {
    const itemKey = opts.key(item)
    const fingerprint = safeFingerprint(opts, item)
    if (
      opts.ledger &&
      !opts.ignoreGate &&
      !opts.ledger.allows(opts.pass, itemKey, fingerprint, now())
    ) {
      report.skipped.push(item)
      continue
    }
    try {
      run(item)
    } catch (raw) {
      if (opts.isFatal?.(raw)) throw raw
      const error = toError(raw)
      const input = failureInput(opts, item, itemKey, fingerprint, error)
      log(
        `[${opts.pass}] ${itemKey} failed (${input.kind}); continuing with the other items:`,
        error
      )
      report.failed.push({ item, key: itemKey, kind: input.kind, error })
      opts.ledger?.record(input, now())
      continue
    }
    report.ok++
    opts.ledger?.clear(opts.pass, itemKey)
  }
  return report
}
