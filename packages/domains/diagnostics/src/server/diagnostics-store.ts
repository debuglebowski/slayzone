import type { Database } from 'better-sqlite3'
import type {
  ClientDiagnosticEventInput,
  ClientErrorEventInput,
  DiagnosticEvent,
  DiagnosticsConfig,
  DiagnosticsExportBundle,
  DiagnosticsExportRequest,
} from '../shared'

export const REDACTION_VERSION = 1

const CONFIG_KEYS = {
  enabled: 'diagnostics_enabled',
  verbose: 'diagnostics_verbose',
  includePtyOutput: 'diagnostics_include_pty_output',
  retentionDays: 'diagnostics_retention_days',
} as const

const DEFAULT_CONFIG: DiagnosticsConfig = {
  enabled: true,
  verbose: false,
  includePtyOutput: false,
  retentionDays: 14,
}

let settingsDb: Database | null = null
let diagnosticsDb: Database | null = null
let cachedConfig: DiagnosticsConfig | null = null

const PENDING_EVENTS_CAP = 1000
const pendingEvents: DiagnosticEvent[] = []

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

function getSetting(db: Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

function setSetting(db: Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

export function bindDiagnosticsDbs(opts: { settingsDb: Database; diagnosticsDb: Database }): void {
  settingsDb = opts.settingsDb
  diagnosticsDb = opts.diagnosticsDb
  cachedConfig = null

  if (pendingEvents.length > 0) {
    const queued = pendingEvents.splice(0, pendingEvents.length)
    for (const ev of queued) recordDiagnosticEvent(ev)
  }
}

export function getDiagnosticsDb(): Database | null {
  return diagnosticsDb
}

export function clearConfigCache(): void {
  cachedConfig = null
}

export function getDiagnosticsConfig(): DiagnosticsConfig {
  if (!settingsDb) return DEFAULT_CONFIG
  if (cachedConfig) return cachedConfig
  cachedConfig = {
    enabled: boolFromSetting(getSetting(settingsDb, CONFIG_KEYS.enabled), DEFAULT_CONFIG.enabled),
    verbose: boolFromSetting(getSetting(settingsDb, CONFIG_KEYS.verbose), DEFAULT_CONFIG.verbose),
    includePtyOutput: boolFromSetting(
      getSetting(settingsDb, CONFIG_KEYS.includePtyOutput),
      DEFAULT_CONFIG.includePtyOutput,
    ),
    retentionDays: intFromSetting(
      getSetting(settingsDb, CONFIG_KEYS.retentionDays),
      DEFAULT_CONFIG.retentionDays,
    ),
  }
  return cachedConfig
}

export function saveDiagnosticsConfig(partial: Partial<DiagnosticsConfig>): DiagnosticsConfig {
  if (!settingsDb) return DEFAULT_CONFIG
  const next: DiagnosticsConfig = { ...getDiagnosticsConfig(), ...partial }

  setSetting(settingsDb, CONFIG_KEYS.enabled, next.enabled ? '1' : '0')
  setSetting(settingsDb, CONFIG_KEYS.verbose, next.verbose ? '1' : '0')
  setSetting(settingsDb, CONFIG_KEYS.includePtyOutput, next.includePtyOutput ? '1' : '0')
  setSetting(settingsDb, CONFIG_KEYS.retentionDays, String(Math.max(1, next.retentionDays)))

  cachedConfig = null
  return getDiagnosticsConfig()
}

function maybeTrimLongString(value: string): string {
  if (value.length <= 4096) return value
  return `${value.slice(0, 4096)}...[trimmed:${value.length - 4096}]`
}

function redactString(value: string): string {
  let redacted = value
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [REDACTED]')
  redacted = redacted.replace(/(token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
  redacted = redacted.replace(/sk-[A-Za-z0-9]{16,}/g, 'sk-[REDACTED]')
  redacted = redacted.replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_[REDACTED]')
  redacted = redacted.replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[REDACTED_KEY_MATERIAL]')
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
      if (lower.includes('token') || lower.includes('secret') || lower.includes('password') || lower.includes('authorization') || lower.includes('cookie')) {
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
    if (pendingEvents.length < PENDING_EVENTS_CAP) {
      pendingEvents.push({ ...event, tsMs: event.tsMs ?? Date.now() })
    }
    return
  }

  if (!diagnosticsDb.open) return

  const config = getDiagnosticsConfig()
  if (!config.enabled) return

  if (!config.verbose && event.level === 'debug') return

  const payloadJson = buildPayloadJson(event.payload)

  try {
    diagnosticsDb
      .prepare(`
        INSERT INTO diagnostics_events (
          id, ts_ms, level, source, event, trace_id, task_id, project_id,
          session_id, channel, message, payload_json, redaction_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
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
        payloadJson,
        REDACTION_VERSION,
      )
  } catch {
    /* DB may close mid-write; diagnostics is best-effort */
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
      snapshot: input.snapshot ?? null,
    },
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
    payload: input.payload ?? null,
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
    })(),
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

  return { total: rows.length, byLevel, bySource, byEvent, firstErrorTsMs }
}

export type BuildExportBundleOpts = {
  request: DiagnosticsExportRequest
  appVersion: string
  platform: string
}

export function buildExportBundle(opts: BuildExportBundleOpts): DiagnosticsExportBundle | null {
  if (!diagnosticsDb) return null

  const fromTsMs = Math.max(0, opts.request.fromTsMs)
  const toTsMs = Math.max(fromTsMs, opts.request.toTsMs)

  const rows = diagnosticsDb
    .prepare(`
      SELECT id, ts_ms, level, source, event, trace_id, task_id, project_id, session_id, channel, message, payload_json
      FROM diagnostics_events
      WHERE ts_ms BETWEEN ? AND ?
      ORDER BY ts_ms ASC
    `)
    .all(fromTsMs, toTsMs) as DiagnosticsEventRow[]

  const config = getDiagnosticsConfig()
  return {
    meta: {
      appVersion: opts.appVersion,
      platform: opts.platform,
      exportedAtTsMs: Date.now(),
      config,
    },
    incidentWindow: { fromTsMs, toTsMs },
    events: mapRowsToExport(rows),
    summary: buildSummary(rows),
    redaction: { version: REDACTION_VERSION, includePtyOutput: config.includePtyOutput },
  }
}
