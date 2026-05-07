import electron, { type IpcMain, type App } from 'electron'
import type { Database } from 'better-sqlite3'
import {
  bindDiagnosticsDbs,
  getDiagnosticsConfig,
  recordDiagnosticEvent,
  startRetentionScheduler,
  stopRetentionScheduler,
} from '../server'
import type { DiagnosticEvent } from '../shared'

// Re-exports for legacy import sites — once Phase 2 finishes, callers should
// import directly from @slayzone/diagnostics/server. Kept for diff size.
export {
  getDiagnosticsConfig,
  saveDiagnosticsConfig,
  recordDiagnosticEvent,
  normalizeClientError,
  normalizeClientEvent,
  buildExportBundle,
  redactValue,
  buildPayloadJson,
  REDACTION_VERSION,
} from '../server'

const IPC_PAYLOAD_SKIP_CHANNELS = new Set(['pty:write', 'pty:getBufferSince', 'pty:getBuffer'])
const CRITICAL_SETTINGS_KEYS = new Set([
  'theme',
  'shell',
  'default_terminal_mode',
  'diagnostics_enabled',
  'diagnostics_verbose',
  'diagnostics_include_pty_output',
  'diagnostics_retention_days',
])

const electronRuntime = electron as unknown as Partial<typeof import('electron')>
let isIpcInstrumented = false

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
      key: typeof objectValue.key === 'string' ? objectValue.key : null,
    }
  }
  return { type: typeof value }
}

function buildDbMutationEvent(
  channel: string,
  args: unknown[],
  traceId: string,
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
        args: args.map((arg) => summarizeMutationArg(arg)),
      },
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
      args: args.map((arg) => summarizeMutationArg(arg)),
    },
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
      stack: error.stack ?? null,
    }
  }
  return { value: toErrorMessage(error) }
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
        payload: includePayload ? { args: summarizeArgs(args) } : { skipped: true },
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
            resultType: result == null ? null : typeof result,
          },
        })

        const dbMutationEvent = buildDbMutationEvent(channel, args, traceId)
        if (dbMutationEvent) {
          recordDiagnosticEvent({
            level: 'info',
            source: channel === 'diagnostics:setConfig' ? 'settings' : 'db',
            event: 'db.mutation',
            ...dbMutationEvent,
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
            error: toErrorPayload(error),
          },
        })
        throw error
      }
    }

    return originalHandle(channel, wrapped as (...args: unknown[]) => unknown)
  }

  ;(ipcMain as unknown as { handle: typeof ipcMain.handle }).handle = patchedHandle as typeof ipcMain.handle
}

/**
 * Wires diagnostics into Electron main: binds the DBs (so server fns work),
 * starts the retention scheduler, and instruments ipcMain. Diagnostics IPC
 * handlers are gone — moved to tRPC `diagnostics.*` router.
 */
export function registerDiagnosticsHandlers(ipcMain: IpcMain, db: Database, eventsDb: Database): void {
  bindDiagnosticsDbs({ settingsDb: db, diagnosticsDb: eventsDb })

  instrumentIpcMain(ipcMain)

  startRetentionScheduler({
    getDb: () => eventsDb,
    getConfig: getDiagnosticsConfig,
    getIdleSeconds: () =>
      electronRuntime.powerMonitor?.getSystemIdleTime?.() ?? Number.MAX_SAFE_INTEGER,
  })
}

const CONSOLE_RING_SIZE = 50
const consoleRing: Array<{ ts: number; level: string; message: string; sourceId: string; line: number }> = []

export function registerProcessDiagnostics(electronApp: App): void {
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
      payload: toErrorPayload(error),
    })
  })

  process.on('unhandledRejection', (reason) => {
    recordDiagnosticEvent({
      level: 'error',
      source: 'main',
      event: 'main.unhandled_rejection',
      message: toErrorMessage(reason),
      payload: toErrorPayload(reason),
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
        memoryInfo,
      },
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
        ...(gpuInfo ? { gpuInfo } : {}),
      },
    })
  })
}

export function stopDiagnostics(): void {
  stopRetentionScheduler()
}
