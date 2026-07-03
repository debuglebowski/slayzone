export type DiagnosticLevel = 'debug' | 'info' | 'warn' | 'error'

export type DiagnosticSource =
  | 'ipc'
  | 'pty'
  | 'main'
  | 'server'
  | 'renderer'
  | 'git'
  | 'gh'
  | 'task'
  | 'browser'
  | 'settings'
  | 'db'
  | 'usage'
  | 'diagnostics'

export interface DiagnosticEvent {
  id?: string
  tsMs?: number
  level: DiagnosticLevel
  source: DiagnosticSource
  event: string
  traceId?: string | null
  taskId?: string | null
  projectId?: string | null
  sessionId?: string | null
  channel?: string | null
  message?: string | null
  payload?: unknown
}

export interface DiagnosticsConfig {
  enabled: boolean
  verbose: boolean
  includePtyOutput: boolean
  retentionDays: number
}

export interface DiagnosticsExportRequest {
  fromTsMs: number
  toTsMs: number
}

export interface DiagnosticsExportSummary {
  total: number
  byLevel: Record<string, number>
  bySource: Record<string, number>
  byEvent: Record<string, number>
  firstErrorTsMs: number | null
}

export interface DiagnosticsExportBundle {
  meta: {
    appVersion: string
    platform: string
    exportedAtTsMs: number
    config: DiagnosticsConfig
  }
  incidentWindow: {
    fromTsMs: number
    toTsMs: number
  }
  events: Array<{
    id: string
    tsMs: number
    level: DiagnosticLevel
    source: DiagnosticSource
    event: string
    traceId: string | null
    taskId: string | null
    projectId: string | null
    sessionId: string | null
    channel: string | null
    message: string | null
    payload: unknown
  }>
  summary: DiagnosticsExportSummary
  redaction: {
    version: number
    includePtyOutput: boolean
  }
}

export interface DiagnosticsExportResult {
  success: boolean
  canceled?: boolean
  path?: string
  eventCount?: number
  error?: string
}

export interface ClientErrorEventInput {
  type: 'window.error' | 'window.unhandledrejection' | 'error-boundary'
  message: string
  stack?: string | null
  componentStack?: string | null
  url?: string | null
  line?: number | null
  column?: number | null
  snapshot?: Record<string, unknown> | null
}

export interface ClientDiagnosticEventInput {
  event: string
  level?: DiagnosticLevel
  message?: string | null
  traceId?: string | null
  taskId?: string | null
  projectId?: string | null
  sessionId?: string | null
  channel?: string | null
  payload?: unknown
}
