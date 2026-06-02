import type { SlayzoneDb } from '@slayzone/platform'
import type {
  ClientDiagnosticEventInput,
  ClientErrorEventInput,
  DiagnosticEvent,
  DiagnosticsConfig,
  DiagnosticsExportBundle,
  DiagnosticsExportRequest
} from '../shared'

// Electron-free data core for diagnostics. Holds the bound DBs, config cache and
// event write-queue as module singletons. Both the IPC handlers (src/main) and
// the tRPC router (@slayzone/transport) delegate here, so there is exactly one
// queue / one cache regardless of transport. No `electron` import — keeps the
// transport server graph portable (local + remote).

export const REDACTION_VERSION = 1

export const CONFIG_KEYS = {
  enabled: 'diagnostics_enabled',
  verbose: 'diagnostics_verbose',
  includePtyOutput: 'diagnostics_include_pty_output',
  retentionDays: 'diagnostics_retention_days'
} as const

const DEFAULT_CONFIG: DiagnosticsConfig = {
  enabled: true,
  verbose: false,
  includePtyOutput: false,
  retentionDays: 14
}

// Write-batching tunables. Inserts go through a bounded in-memory queue and
// flush periodically inside a single transaction — main process never blocks
// per-event. Errors flush immediately so failures persist on crash.
const WRITE_BATCH_SIZE = 1000
const WRITE_FLUSH_INTERVAL_MS = 2_000
const WRITE_QUEUE_CAP = 5_000

let settingsDb: SlayzoneDb | null = null // main DB — reads/writes diagnostics config from settings table
let diagnosticsDb: SlayzoneDb | null = null // separate diagnostics-only DB — writes events to slayzone.dev.diagnostics.sqlite
let cachedConfig: DiagnosticsConfig | null = null

// Pre-registration buffer: events recorded before bindDiagnosticsDbs runs are
// queued here and flushed on bind. Bounded to prevent unbounded memory if bind
// never happens.
const PENDING_EVENTS_CAP = 1000
const pendingEvents: DiagnosticEvent[] = []

// Post-bind write queue — drained periodically into a single transaction.
// Bounded so a runaway producer can't OOM the process.
const writeQueue: DiagnosticEvent[] = []
let flushTimer: NodeJS.Timeout | null = null
// Count of events dropped due to WRITE_QUEUE_CAP since last successful flush.
// Surfaced as a single `diag.dropped` event so spikes are observable instead
// of silent. Reset to 0 once the synthetic event is enqueued.
let droppedSinceLastFlush = 0

export interface DiagnosticsEventRow {
  id: string
  ts_ms: number
  level: 'debug' | 'info' | 'warn' | 'error'
  source: string
  event: string
  trace_id: string | null
  task_id: string | null
  project_id: string | null
  session_id: string | null
  channel: string | null
  message: string | null
  payload_json: string | null
}

function boolFromSetting(value: string | null | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return value === '1' || value === 'true'
}

function intFromSetting(value: string | null | undefined, fallback: number): number {
  if (value == null) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return parsed
}

async function getSetting(db: SlayzoneDb, key: string): Promise<string | null> {
  const row = (await db.prepare('SELECT value FROM settings WHERE key = ?').get(key)) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

async function setSetting(db: SlayzoneDb, key: string, value: string): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

// Binds the settings + diagnostics DBs, resets the cache, warms it out-of-band
// and flushes any events buffered before bind. Called once from the main
// process (registerDiagnosticsHandlers) at boot.
export function bindDiagnosticsDbs(opts: {
  settingsDb: SlayzoneDb
  diagnosticsDb: SlayzoneDb
}): void {
  settingsDb = opts.settingsDb // main DB — for config settings reads/writes
  diagnosticsDb = opts.diagnosticsDb // separate diagnostics DB — writes to slayzone.dev.diagnostics.sqlite
  cachedConfig = null

  // Warm the config cache from the (async, worker-thread) settings DB so the
  // synchronous getDiagnosticsConfig() hot path serves real values. Fire-and-
  // forget — until it resolves, callers fall back to defaults.
  void loadDiagnosticsConfig()

  // Flush events buffered before bind. Splice out so re-bind (tests) doesn't
  // double-write, and recordDiagnosticEvent now writes directly.
  if (pendingEvents.length > 0) {
    const queued = pendingEvents.splice(0, pendingEvents.length)
    for (const ev of queued) recordDiagnosticEvent(ev)
  }
}

export function getDiagnosticsDb(): SlayzoneDb | null {
  return diagnosticsDb
}

export function clearConfigCache(): void {
  cachedConfig = null
}

// Reads diagnostics config from the settings DB and populates the cache. Reads
// are async (worker-thread DB), so this seeds `cachedConfig` once and the
// synchronous `getDiagnosticsConfig()` serves the hot path (per-event + IPC
// wrapper) from that cache. Called on bind and after every config save.
async function loadDiagnosticsConfig(): Promise<DiagnosticsConfig> {
  if (!settingsDb) return DEFAULT_CONFIG
  if (cachedConfig) return cachedConfig
  cachedConfig = {
    enabled: boolFromSetting(
      await getSetting(settingsDb, CONFIG_KEYS.enabled),
      DEFAULT_CONFIG.enabled
    ),
    verbose: boolFromSetting(
      await getSetting(settingsDb, CONFIG_KEYS.verbose),
      DEFAULT_CONFIG.verbose
    ),
    includePtyOutput: boolFromSetting(
      await getSetting(settingsDb, CONFIG_KEYS.includePtyOutput),
      DEFAULT_CONFIG.includePtyOutput
    ),
    retentionDays: intFromSetting(
      await getSetting(settingsDb, CONFIG_KEYS.retentionDays),
      DEFAULT_CONFIG.retentionDays
    )
  }
  return cachedConfig
}

// Synchronous, cache-only view of the config. The DB read happens out-of-band
// in loadDiagnosticsConfig; until that completes the cache is null and we fall
// back to defaults. Keeping this sync preserves the fire-and-forget contract of
// recordDiagnosticEvent and the IPC instrumentation hot path.
export function getDiagnosticsConfig(): DiagnosticsConfig {
  if (!settingsDb) return DEFAULT_CONFIG
  return cachedConfig ?? DEFAULT_CONFIG
}

export async function saveDiagnosticsConfig(
  partial: Partial<DiagnosticsConfig>
): Promise<DiagnosticsConfig> {
  if (!settingsDb) return DEFAULT_CONFIG
  const next: DiagnosticsConfig = {
    ...(await loadDiagnosticsConfig()),
    ...partial
  }

  await setSetting(settingsDb, CONFIG_KEYS.enabled, next.enabled ? '1' : '0')
  await setSetting(settingsDb, CONFIG_KEYS.verbose, next.verbose ? '1' : '0')
  await setSetting(settingsDb, CONFIG_KEYS.includePtyOutput, next.includePtyOutput ? '1' : '0')
  await setSetting(settingsDb, CONFIG_KEYS.retentionDays, String(Math.max(1, next.retentionDays)))

  cachedConfig = null
  return loadDiagnosticsConfig()
}

function maybeTrimLongString(value: string): string {
  if (value.length <= 4096) return value
  return `${value.slice(0, 4096)}...[trimmed:${value.length - 4096}]`
}

function redactString(value: string): string {
  let redacted = value
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [REDACTED]')
  redacted = redacted.replace(
    /(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,;]+/gi,
    '$1=[REDACTED]'
  )
  redacted = redacted.replace(/sk-[A-Za-z0-9]{16,}/g, 'sk-[REDACTED]')
  redacted = redacted.replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_[REDACTED]')
  redacted = redacted.replace(
    /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
    '[REDACTED_KEY_MATERIAL]'
  )
  return maybeTrimLongString(redacted)
}

export function redactValue(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((item) => redactValue(item)).slice(0, 200)
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase()
      if (
        lower.includes('token') ||
        lower.includes('secret') ||
        lower.includes('password') ||
        lower.includes('authorization') ||
        lower.includes('cookie')
      ) {
        output[key] = '[REDACTED]'
        continue
      }
      output[key] = redactValue(raw)
    }
    return output
  }
  return String(value)
}

export function buildPayloadJson(payload: unknown): string | null {
  if (payload == null) return null
  try {
    return JSON.stringify(redactValue(payload))
  } catch {
    return JSON.stringify({ value: '[UNSERIALIZABLE_PAYLOAD]' })
  }
}

export function recordDiagnosticEvent(event: DiagnosticEvent): void {
  if (!diagnosticsDb) {
    // Buffer until bindDiagnosticsDbs wires the DB. Stamp tsMs at queue time so
    // events retain their original timestamp on flush.
    if (pendingEvents.length < PENDING_EVENTS_CAP) {
      pendingEvents.push({ ...event, tsMs: event.tsMs ?? Date.now() })
    }
    return
  }

  // DB may be transiently closed (test rewire, shutdown race). Keep queueing —
  // flushWriteQueue will hold the batch until DB is available or drop on cap.
  // Surfaces backpressure via the diag.dropped event rather than silent loss.

  const config = getDiagnosticsConfig()
  if (!config.enabled) return

  if (!config.verbose && event.level === 'debug') return

  // Stamp ts at enqueue time so chronological order survives batch reordering.
  const stamped: DiagnosticEvent = { ...event, tsMs: event.tsMs ?? Date.now() }

  if (writeQueue.length >= WRITE_QUEUE_CAP) {
    // Hard cap: drop newest under load rather than OOM. Count the drop so a
    // subsequent flush can surface it as a single diag.dropped event.
    droppedSinceLastFlush++
    return
  }
  writeQueue.push(stamped)

  // Errors are signal — flush now so a subsequent crash doesn't lose them.
  // Flush is async (worker DB); fire-and-forget to keep this path synchronous.
  if (stamped.level === 'error') {
    void flushWriteQueue()
    return
  }

  if (writeQueue.length >= WRITE_BATCH_SIZE) {
    void flushWriteQueue()
    return
  }

  if (!flushTimer) {
    flushTimer = setTimeout(() => void flushWriteQueue(), WRITE_FLUSH_INTERVAL_MS)
  }
}

const INSERT_EVENT_SQL = `
      INSERT INTO diagnostics_events (
        id, ts_ms, level, source, event, trace_id, task_id, project_id,
        session_id, channel, message, payload_json, redaction_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

// Serializes overlapping flushes. The flush is async (worker DB) and can be
// triggered concurrently (timer, error, batch-size, export). Chaining keeps the
// per-batch single-transaction semantics and stops two batchTxns interleaving.
let flushInFlight: Promise<void> = Promise.resolve()

export function flushWriteQueue(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flushInFlight = flushInFlight.then(drainWriteQueue, drainWriteQueue)
  return flushInFlight
}

async function drainWriteQueue(): Promise<void> {
  if (writeQueue.length === 0 && droppedSinceLastFlush === 0) return
  if (!diagnosticsDb) {
    // Hold the queue — DB may come back. Cap stops unbounded growth; once
    // cap is hit, drop counter takes over.
    return
  }

  const batch = writeQueue.splice(0, writeQueue.length)

  // Surface accumulated cap-drops as a single warn event. Reset the counter
  // here so a failed flush doesn't double-emit on retry — re-accumulation
  // restarts from 0.
  if (droppedSinceLastFlush > 0) {
    batch.unshift({
      level: 'warn',
      source: 'diagnostics',
      event: 'diag.dropped',
      tsMs: Date.now(),
      message: `Dropped ${droppedSinceLastFlush} events at queue cap`,
      payload: { droppedCount: droppedSinceLastFlush, queueCap: WRITE_QUEUE_CAP }
    })
    droppedSinceLastFlush = 0
  }

  try {
    await diagnosticsDb.batchTxn(
      batch.map((event) => ({
        type: 'run' as const,
        sql: INSERT_EVENT_SQL,
        params: [
          event.id ?? crypto.randomUUID(),
          event.tsMs ?? Date.now(),
          event.level,
          event.source,
          event.event,
          event.traceId ?? null,
          event.taskId ?? null,
          event.projectId ?? null,
          event.sessionId ?? null,
          event.channel ?? null,
          event.message ?? null,
          buildPayloadJson(event.payload),
          REDACTION_VERSION
        ]
      }))
    )
  } catch {
    // Race: DB may close mid-flush. Swallow — diagnostics must never escalate to fatal.
  }
}

export function normalizeClientError(input: ClientErrorEventInput): DiagnosticEvent {
  return {
    level: 'error',
    source: 'renderer',
    event: `renderer.${input.type}`,
    message: input.message,
    payload: {
      stack: input.stack ?? null,
      componentStack: input.componentStack ?? null,
      url: input.url ?? null,
      line: input.line ?? null,
      column: input.column ?? null,
      snapshot: input.snapshot ?? null
    }
  }
}

export function normalizeClientEvent(input: ClientDiagnosticEventInput): DiagnosticEvent {
  return {
    level: input.level ?? 'info',
    source: 'renderer',
    event: input.event,
    traceId: input.traceId ?? null,
    taskId: input.taskId ?? null,
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? null,
    channel: input.channel ?? null,
    message: input.message ?? null,
    payload: input.payload ?? null
  }
}

function mapRowsToExport(rows: DiagnosticsEventRow[]): DiagnosticsExportBundle['events'] {
  return rows.map((row) => ({
    id: row.id,
    tsMs: row.ts_ms,
    level: row.level,
    source: row.source as DiagnosticsExportBundle['events'][number]['source'],
    event: row.event,
    traceId: row.trace_id,
    taskId: row.task_id,
    projectId: row.project_id,
    sessionId: row.session_id,
    channel: row.channel,
    message: row.message,
    payload: (() => {
      if (!row.payload_json) return null
      try {
        return JSON.parse(row.payload_json)
      } catch {
        return { value: '[INVALID_JSON_PAYLOAD]' }
      }
    })()
  }))
}

function buildSummary(rows: DiagnosticsEventRow[]): DiagnosticsExportBundle['summary'] {
  const byLevel: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  const byEvent: Record<string, number> = {}
  let firstErrorTsMs: number | null = null

  for (const row of rows) {
    byLevel[row.level] = (byLevel[row.level] ?? 0) + 1
    bySource[row.source] = (bySource[row.source] ?? 0) + 1
    byEvent[row.event] = (byEvent[row.event] ?? 0) + 1
    if (row.level === 'error' && firstErrorTsMs == null) {
      firstErrorTsMs = row.ts_ms
    }
  }

  return {
    total: rows.length,
    byLevel,
    bySource,
    byEvent,
    firstErrorTsMs
  }
}

export type BuildExportBundleOpts = {
  request: DiagnosticsExportRequest
  appVersion: string
  platform: string
}

// Builds the export bundle as plain JSON (no Electron dialog / file write).
// Flushes the write-queue first so the export reflects the latest state, not
// whatever happened to land in the DB before the periodic flush ran. The IPC
// `diagnostics:export` handler (main) wraps this with a save-dialog + writeFile;
// the tRPC `exportBundle` query returns it directly for a browser download.
export async function buildExportBundle(
  opts: BuildExportBundleOpts
): Promise<DiagnosticsExportBundle | null> {
  if (!diagnosticsDb) return null

  await flushWriteQueue()

  const fromTsMs = Math.max(0, opts.request.fromTsMs)
  const toTsMs = Math.max(fromTsMs, opts.request.toTsMs)

  const rows = (await diagnosticsDb
    .prepare(`
      SELECT id, ts_ms, level, source, event, trace_id, task_id, project_id, session_id, channel, message, payload_json
      FROM diagnostics_events
      WHERE ts_ms BETWEEN ? AND ?
      ORDER BY ts_ms ASC
    `)
    .all(fromTsMs, toTsMs)) as DiagnosticsEventRow[]

  const config = getDiagnosticsConfig()
  return {
    meta: {
      appVersion: opts.appVersion,
      platform: opts.platform,
      exportedAtTsMs: Date.now(),
      config
    },
    incidentWindow: {
      fromTsMs,
      toTsMs
    },
    events: mapRowsToExport(rows),
    summary: buildSummary(rows),
    redaction: {
      version: REDACTION_VERSION,
      includePtyOutput: config.includePtyOutput
    }
  }
}
