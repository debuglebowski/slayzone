import electron, { type IpcMain, type App } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'better-sqlite3'
import type {
  ClientDiagnosticEventInput,
  ClientErrorEventInput,
  DiagnosticEvent,
  DiagnosticsConfig,
  DiagnosticsExportBundle,
  DiagnosticsExportRequest,
  DiagnosticsExportResult
} from '../shared'
import { startRetentionScheduler, stopRetentionScheduler } from '../server/retention'

const REDACTION_VERSION = 1

const CONFIG_KEYS = {
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

const IPC_PAYLOAD_SKIP_CHANNELS = new Set(['pty:write', 'pty:getBufferSince', 'pty:getBuffer'])
const CRITICAL_SETTINGS_KEYS = new Set([
  'theme',
  'shell',
  'default_terminal_mode',
  CONFIG_KEYS.enabled,
  CONFIG_KEYS.verbose,
  CONFIG_KEYS.includePtyOutput,
  CONFIG_KEYS.retentionDays
])

let settingsDb: Database | null = null  // main DB — reads/writes diagnostics config from settings table
let diagnosticsDb: Database | null = null  // separate diagnostics-only DB — writes events to slayzone.dev.diagnostics.sqlite
let isIpcInstrumented = false
let cachedConfig: DiagnosticsConfig | null = null

// Pre-registration buffer: events recorded before registerDiagnosticsHandlers
// runs are queued here and flushed on registration. Bounded to prevent
// unbounded memory if registration never happens.
const PENDING_EVENTS_CAP = 1000
const pendingEvents: DiagnosticEvent[] = []

const electronRuntime = electron as unknown as Partial<typeof import('electron')>
const app = electronRuntime.app as App | undefined
const dialog = electronRuntime.dialog
const BrowserWindow = electronRuntime.BrowserWindow

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

export function getDiagnosticsConfig(): DiagnosticsConfig {
  if (!settingsDb) return DEFAULT_CONFIG
  if (cachedConfig) return cachedConfig
  cachedConfig = {
    enabled: boolFromSetting(getSetting(settingsDb, CONFIG_KEYS.enabled), DEFAULT_CONFIG.enabled),
    verbose: boolFromSetting(getSetting(settingsDb, CONFIG_KEYS.verbose), DEFAULT_CONFIG.verbose),
    includePtyOutput: boolFromSetting(
      getSetting(settingsDb, CONFIG_KEYS.includePtyOutput),
      DEFAULT_CONFIG.includePtyOutput
    ),
    retentionDays: intFromSetting(
      getSetting(settingsDb, CONFIG_KEYS.retentionDays),
      DEFAULT_CONFIG.retentionDays
    )
  }
  return cachedConfig
}

function saveDiagnosticsConfig(partial: Partial<DiagnosticsConfig>): DiagnosticsConfig {
  if (!settingsDb) return DEFAULT_CONFIG
  const next: DiagnosticsConfig = {
    ...getDiagnosticsConfig(),
    ...partial
  }

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

function redactValue(value: unknown): unknown {
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

function buildPayloadJson(payload: unknown): string | null {
  if (payload == null) return null
  try {
    return JSON.stringify(redactValue(payload))
  } catch {
    return JSON.stringify({ value: '[UNSERIALIZABLE_PAYLOAD]' })
  }
}

export function recordDiagnosticEvent(event: DiagnosticEvent): void {
  if (!diagnosticsDb) {
    // Buffer until registerDiagnosticsHandlers wires the DB. Stamp tsMs at
    // queue time so events retain their original timestamp on flush.
    if (pendingEvents.length < PENDING_EVENTS_CAP) {
      pendingEvents.push({ ...event, tsMs: event.tsMs ?? Date.now() })
    }
    return
  }

  // DB closed during shutdown — drop the event. Avoids fatal exception when
  // an uncaughtException handler tries to log post-close. Diagnostics during
  // shutdown are best-effort.
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
        REDACTION_VERSION
      )
  } catch {
    // Race: DB may close between the .open check and .prepare. Swallow —
    // diagnostics must never escalate to fatal.
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function toErrorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null
    }
  }
  return { value: toErrorMessage(error) }
}

function summarizeArgs(args: unknown[]): unknown {
  return args.map((arg) => {
    if (arg == null) return arg
    if (typeof arg === 'string') return { type: 'string', length: arg.length }
    if (typeof arg === 'number' || typeof arg === 'boolean') return { type: typeof arg }
    if (Array.isArray(arg)) return { type: 'array', length: arg.length }
    if (typeof arg === 'object') return { type: 'object', keys: Object.keys(arg as Record<string, unknown>).slice(0, 20) }
    return { type: typeof arg }
  })
}

function summarizeMutationArg(value: unknown): unknown {
  if (value == null) return value
  if (typeof value === 'string') {
    if (value.length > 180) return `${value.slice(0, 180)}...[trimmed:${value.length - 180}]`
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return { type: 'array', count: value.length }
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>
    return {
      type: 'object',
      keys: Object.keys(objectValue).slice(0, 20),
      id: typeof objectValue.id === 'string' ? objectValue.id : null,
      taskId: typeof objectValue.taskId === 'string' ? objectValue.taskId : null,
      projectId: typeof objectValue.projectId === 'string' ? objectValue.projectId : null,
      key: typeof objectValue.key === 'string' ? objectValue.key : null
    }
  }
  return { type: typeof value }
}

function buildDbMutationEvent(
  channel: string,
  args: unknown[],
  traceId: string
): Omit<DiagnosticEvent, 'level' | 'source' | 'event'> | null {
  if (channel === 'diagnostics:setConfig') {
    return {
      traceId,
      channel,
      message: 'diagnostics config updated',
      payload: {
        channel,
        entity: 'diagnostics',
        operation: 'setConfig',
        args: args.map((arg) => summarizeMutationArg(arg))
      }
    }
  }

  if (!channel.startsWith('db:')) return null

  const segments = channel.split(':')
  if (segments.length < 3) return null

  const entity = segments[1]
  const operation = segments[2]

  const isMutationOperation =
    operation.includes('create') ||
    operation.includes('update') ||
    operation.includes('delete') ||
    operation.includes('archive') ||
    operation.includes('reorder') ||
    operation.includes('set')

  if (!isMutationOperation) return null

  if (entity === 'settings' && operation === 'set') {
    const key = typeof args[0] === 'string' ? args[0] : null
    if (!key || !CRITICAL_SETTINGS_KEYS.has(key)) return null
  }

  return {
    traceId,
    channel,
    message: `${entity}.${operation}`,
    payload: {
      channel,
      entity,
      operation,
      args: args.map((arg) => summarizeMutationArg(arg))
    }
  }
}

function buildTraceId(channel: string, tsMs: number): string {
  return `${channel}:${tsMs}:${Math.random().toString(36).slice(2, 8)}`
}

export type IpcSuccessHook = (channel: string, args: unknown[], result: unknown) => void

let ipcSuccessHook: IpcSuccessHook | null = null

export function setIpcSuccessHook(hook: IpcSuccessHook): void {
  ipcSuccessHook = hook
}

function instrumentIpcMain(ipcMain: IpcMain): void {
  if (isIpcInstrumented) return
  isIpcInstrumented = true

  const originalHandle = ipcMain.handle.bind(ipcMain)

  const patchedHandle = (channel: string, listener: (...args: unknown[]) => unknown) => {
    const wrapped = async (event: unknown, ...args: unknown[]) => {
      const startedAt = Date.now()
      const traceId = buildTraceId(channel, startedAt)
      const includePayload = !IPC_PAYLOAD_SKIP_CHANNELS.has(channel)

      recordDiagnosticEvent({
        level: 'info',
        source: 'ipc',
        event: 'ipc.request',
        traceId,
        channel,
        message: channel,
        payload: includePayload ? { args: summarizeArgs(args) } : { skipped: true }
      })

      try {
        const result = await listener(event, ...args)
        recordDiagnosticEvent({
          level: 'info',
          source: 'ipc',
          event: 'ipc.response',
          traceId,
          channel,
          message: channel,
          payload: {
            durationMs: Date.now() - startedAt,
            resultType: result == null ? null : typeof result
          }
        })

        const dbMutationEvent = buildDbMutationEvent(channel, args, traceId)
        if (dbMutationEvent) {
          recordDiagnosticEvent({
            level: 'info',
            source: channel === 'diagnostics:setConfig' ? 'settings' : 'db',
            event: 'db.mutation',
            ...dbMutationEvent
          })
        }

        ipcSuccessHook?.(channel, args, result)

        return result
      } catch (error) {
        recordDiagnosticEvent({
          level: 'error',
          source: 'ipc',
          event: 'ipc.error',
          traceId,
          channel,
          message: toErrorMessage(error),
          payload: {
            durationMs: Date.now() - startedAt,
            error: toErrorPayload(error)
          }
        })
        throw error
      }
    }

    return originalHandle(channel, wrapped as (...args: unknown[]) => unknown)
  }

  ;(ipcMain as unknown as { handle: typeof ipcMain.handle }).handle = patchedHandle as typeof ipcMain.handle
}

function normalizeClientError(input: ClientErrorEventInput): DiagnosticEvent {
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

function normalizeClientEvent(input: ClientDiagnosticEventInput): DiagnosticEvent {
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

async function runExport(request: DiagnosticsExportRequest): Promise<DiagnosticsExportResult> {
  if (!diagnosticsDb) {
    return { success: false, error: 'Diagnostics database not initialized' }
  }

  const fromTsMs = Math.max(0, request.fromTsMs)
  const toTsMs = Math.max(fromTsMs, request.toTsMs)

  const rows = diagnosticsDb
    .prepare(`
      SELECT id, ts_ms, level, source, event, trace_id, task_id, project_id, session_id, channel, message, payload_json
      FROM diagnostics_events
      WHERE ts_ms BETWEEN ? AND ?
      ORDER BY ts_ms ASC
    `)
    .all(fromTsMs, toTsMs) as DiagnosticsEventRow[]

  const config = getDiagnosticsConfig()
  const bundle: DiagnosticsExportBundle = {
    meta: {
      appVersion: app?.getVersion?.() ?? 'unknown',
      platform: process.platform,
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

  if (!dialog?.showSaveDialog) {
    return { success: false, error: 'Diagnostics export requires Electron dialog APIs' }
  }

  const focusedWindow = BrowserWindow?.getFocusedWindow?.() ?? undefined
  const defaultPath = path.join(
    app?.getPath?.('downloads') ?? process.cwd(),
    `slayzone-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  )

  const saveResult = focusedWindow
    ? await dialog.showSaveDialog(focusedWindow, {
      title: 'Export Diagnostics',
      defaultPath,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    : await dialog.showSaveDialog({
      title: 'Export Diagnostics',
      defaultPath,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })

  if (saveResult.canceled || !saveResult.filePath) {
    return { success: false, canceled: true }
  }

  fs.writeFileSync(saveResult.filePath, JSON.stringify(bundle, null, 2), 'utf8')

  recordDiagnosticEvent({
    level: 'info',
    source: 'main',
    event: 'diagnostics.exported',
    message: saveResult.filePath,
    payload: {
      fromTsMs,
      toTsMs,
      eventCount: rows.length
    }
  })

  return {
    success: true,
    path: saveResult.filePath,
    eventCount: rows.length
  }
}

export function registerDiagnosticsHandlers(ipcMain: IpcMain, db: Database, eventsDb: Database): void {
  settingsDb = db      // main DB — for config settings reads/writes
  diagnosticsDb = eventsDb  // separate diagnostics DB — writes to slayzone.dev.diagnostics.sqlite
  cachedConfig = null

  // Flush events buffered before registration. Splice out so re-registration
  // (tests) doesn't double-write, and recordDiagnosticEvent now writes directly.
  if (pendingEvents.length > 0) {
    const queued = pendingEvents.splice(0, pendingEvents.length)
    for (const ev of queued) recordDiagnosticEvent(ev)
  }

  instrumentIpcMain(ipcMain)

  startRetentionScheduler({
    getDb: () => diagnosticsDb,
    getConfig: getDiagnosticsConfig,
    getIdleSeconds: () =>
      electronRuntime.powerMonitor?.getSystemIdleTime?.() ?? Number.MAX_SAFE_INTEGER
  })

  ipcMain.handle('diagnostics:getConfig', () => getDiagnosticsConfig())

  ipcMain.handle('diagnostics:setConfig', (_, config: Partial<DiagnosticsConfig>) => {
    return saveDiagnosticsConfig(config)
  })

  ipcMain.handle('diagnostics:recordClientError', (_, input: ClientErrorEventInput) => {
    recordDiagnosticEvent(normalizeClientError(input))
  })

  ipcMain.handle('diagnostics:recordClientEvent', (_, input: ClientDiagnosticEventInput) => {
    recordDiagnosticEvent(normalizeClientEvent(input))
  })

  ipcMain.handle('diagnostics:export', (_, request: DiagnosticsExportRequest) => {
    return runExport(request)
  })
}

const CONSOLE_RING_SIZE = 50
const consoleRing: Array<{ ts: number; level: string; message: string; sourceId: string; line: number }> = []

export function registerProcessDiagnostics(electronApp: App): void {
  // Capture renderer console output in a rolling buffer — flushed into crash diagnostics
  electronApp.on('web-contents-created', (_event, webContents) => {
    webContents.on('console-message', ({ level, message, lineNumber, sourceId }) => {
      if (consoleRing.length >= CONSOLE_RING_SIZE) consoleRing.shift()
      consoleRing.push({ ts: Date.now(), level, message: message.slice(0, 500), sourceId, line: lineNumber })
    })
  })

  process.on('uncaughtException', (error) => {
    recordDiagnosticEvent({
      level: 'error',
      source: 'main',
      event: 'main.uncaught_exception',
      message: error.message,
      payload: toErrorPayload(error)
    })
  })

  process.on('unhandledRejection', (reason) => {
    recordDiagnosticEvent({
      level: 'error',
      source: 'main',
      event: 'main.unhandled_rejection',
      message: toErrorMessage(reason),
      payload: toErrorPayload(reason)
    })
  })

  electronApp.on('render-process-gone', async (_, webContents, details) => {
    let gpuInfo: unknown = null
    try { gpuInfo = await electronApp.getGPUInfo('basic') } catch { /* GPU info unavailable */ }

    let memoryInfo: unknown = null
    try { memoryInfo = process.memoryUsage() } catch { /* ignore */ }

    recordDiagnosticEvent({
      level: 'error',
      source: 'main',
      event: 'renderer.process_gone',
      message: details.reason,
      payload: {
        webContentsId: webContents.id,
        reason: details.reason,
        exitCode: details.exitCode,
        consoleRing: [...consoleRing],
        gpuInfo,
        memoryInfo
      }
    })

    consoleRing.length = 0
  })

  electronApp.on('child-process-gone', async (_, details) => {
    let gpuInfo: unknown = null
    if (details.type === 'GPU') {
      try { gpuInfo = await electronApp.getGPUInfo('basic') } catch { /* ignore */ }
    }

    recordDiagnosticEvent({
      level: 'error',
      source: 'main',
      event: 'main.child_process_gone',
      message: details.type,
      payload: {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        serviceName: details.serviceName,
        name: details.name,
        ...(gpuInfo ? { gpuInfo } : {})
      }
    })
  })
}

export function stopDiagnostics(): void {
  stopRetentionScheduler()
}
