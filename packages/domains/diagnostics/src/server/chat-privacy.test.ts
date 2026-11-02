import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { createSlayzoneDbAdapter } from '../../../../shared/test-utils/ipc-harness'
import { createDiagnosticsSchema } from './schema'
import {
  bindDiagnosticsDbs,
  flushWriteQueue,
  recordDiagnosticEvent,
  normalizeClientError
} from './diagnostics-store'
import { chatSafeDiagnostic } from './chat-privacy'

test('chat IPC errors redact private payloads and filtering preserves already-safe stack positions', () => {
  const safe = chatSafeDiagnostic({
    level: 'error',
    source: 'ipc',
    event: 'ipc.error',
    channel: 'chat:send',
    message: 'private error',
    payload: {
      stack: 'Error: private error\n    at send (/app/index.js:7:2)',
      args: ['private message'],
      durationMs: 2
    }
  })
  expect(safe.message).toBeNull()
  expect(safe.payload).toEqual({ durationMs: 2, frames: ['index.js:7:2'] })
  expect(chatSafeDiagnostic(safe)).toEqual(safe)
})

test('chat/renderer diagnostics retain metadata without persisting content or screenshot blobs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-diagnostic-privacy-')),
    path = join(dir, 'diagnostics.sqlite'),
    blobs = join(dir, 'blobs')
  const raw = new Database(path),
    secret = 'PRIVATE-CHAT-DIAGNOSTIC-MARKER'
  try {
    createDiagnosticsSchema(raw)
    // Also cover the queue populated before diagnostics is bound at boot.
    recordDiagnosticEvent({
      level: 'warn',
      source: 'main',
      event: 'chat.interrupt_fallback',
      taskId: 't',
      message: secret,
      payload: {
        tabId: 'tab',
        mode: 'claude-chat',
        seq: 7,
        error: secret,
        nested: { prompt: secret }
      }
    })
    bindDiagnosticsDbs({
      diagnosticsDb: createSlayzoneDbAdapter(raw),
      blobDir: blobs,
      localConfig: () => ({ enabled: true, verbose: true, includePtyOutput: true })
    })
    const image = `data:image/png;base64,${Buffer.from(secret.repeat(1000)).toString('base64')}`
    recordDiagnosticEvent({
      level: 'info',
      source: 'renderer',
      event: 'renderer.chat.scroll.canary',
      taskId: 't',
      message: secret,
      payload: { inFlight: true, scrollTop: 12, text: secret, screenshotDataUrl: image }
    })
    recordDiagnosticEvent(
      normalizeClientError({
        type: 'error-boundary',
        message: secret,
        stack: `Error: ${secret}\n    at renderChat (https://app.invalid/assets/app.js:42:7)`,
        snapshot: { chat: { text: secret }, screenshotDataUrl: image }
      })
    )
    recordDiagnosticEvent({
      level: 'info',
      source: 'server',
      event: 'hub.ready',
      message: 'Listening',
      payload: { port: 8788 }
    })
    await flushWriteQueue()
    const rows = raw
      .prepare('SELECT event,message,payload_json FROM diagnostics_events ORDER BY ts_ms')
      .all() as Array<{ event: string; message: string | null; payload_json: string | null }>
    expect(rows).toHaveLength(4)
    expect(JSON.stringify(rows)).not.toContain(secret)
    expect(
      JSON.parse(rows.find((row) => row.event === 'chat.interrupt_fallback')!.payload_json!)
    ).toMatchObject({ tabId: 'tab', mode: 'claude-chat', seq: 7 })
    expect(
      JSON.parse(rows.find((row) => row.event === 'renderer.chat.scroll.canary')!.payload_json!)
    ).toMatchObject({ inFlight: true, scrollTop: 12 })
    expect(rows.find((row) => row.event === 'hub.ready')!.message).toBe('Listening')
    expect(existsSync(blobs) ? readdirSync(blobs) : []).toEqual([])
    raw.close()
    expect(readFileSync(path).includes(Buffer.from(secret))).toBe(false)
  } finally {
    if (raw.open) raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
