import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { expect, test, vi } from 'vitest'
import { createStorageCopyBroker } from './storage-copy-broker'
import type { CompactionWorkerInput } from './compaction-worker-host'
import type { HostControl } from './storage-owner-protocol'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chat-copy-broker-'))
  const live = join(dir, 'live.sqlite')
  const db = new Database(live)
  try {
    db.exec('CREATE TABLE content(id INTEGER PRIMARY KEY, body BLOB)')
    db.transaction(() => {
      const put = db.prepare('INSERT INTO content VALUES(?,?)')
      for (let i = 0; i < 24; i++) put.run(i, Buffer.alloc(64 * 1024, i))
    })()
  } finally {
    db.close()
  }
  const spec: CompactionWorkerInput = {
    mode: 'file',
    live,
    out: join(dir, 'copy.sqlite'),
    tables: [{ name: 'content', cols: ['id', 'body'], pk: ['id'], withoutRowid: false }],
    throttle: { batchBytes: 64 * 1024, syncBytes: 64 * 1024, pauseMs: 25 }
  }
  return { dir, spec }
}

test('main copy broker closes an active native copy through physical exit without owner participation', async () => {
  const { dir, spec } = fixture()
  const messages: HostControl[] = []
  let progress: () => void = () => undefined
  const copying = new Promise<void>((resolve) => {
    progress = resolve
  })
  const broker = createStorageCopyBroker((message) => {
    messages.push(message)
    if (message.type === 'copy-progress') progress()
  })
  const sql = vi.spyOn(Database.prototype, 'prepare')
  try {
    const ready = broker.request({ operation: 'copy-start', token: 'copy', spec })
    // Attach before stopping: startup rejects when its physically active thread ends.
    const result = ready.catch((error) => error as Error)
    await copying
    expect(messages.some((m) => m.type === 'copy-exit')).toBe(false)
    await broker.close()
    expect(await result).toBeInstanceOf(Error)
    expect(messages.filter((m) => m.type === 'copy-exit')).toEqual([
      { type: 'copy-exit', token: 'copy' }
    ])
    expect(sql).not.toHaveBeenCalled()
    // Thread ended before disposal. Windows exercises open-file deletion semantics;
    // POSIX deletion alone is not evidence of physical descriptor release.
    rmSync(spec.out, { force: true })
    expect(existsSync(spec.out)).toBe(false)
    await expect(broker.request({ operation: 'copy-start', token: 'late', spec })).rejects.toThrow(
      /closed/
    )
  } finally {
    sql.mockRestore()
    await broker.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finished copies acknowledge only after physical exit; native startup failure also drains', async () => {
  const { dir, spec } = fixture()
  const messages: HostControl[] = []
  const broker = createStorageCopyBroker((message) => messages.push(message))
  try {
    await broker.request({
      operation: 'copy-start',
      token: 'done',
      spec: { ...spec, throttle: { ...spec.throttle, pauseMs: 0 } }
    })
    expect(await broker.request({ operation: 'copy-finish', token: 'done', check: true })).toBe(
      'ok'
    )
    expect(messages).toContainEqual({ type: 'copy-exit', token: 'done' })
    const check = new Database(spec.out, { readonly: true })
    try {
      expect(check.prepare('SELECT count(*) n FROM content').get()).toEqual({ n: 24 })
    } finally {
      check.close()
    }
    await expect(
      broker.request({
        operation: 'copy-start',
        token: 'bad',
        spec: { ...spec, live: join(dir, 'absent') }
      })
    ).rejects.toThrow()
    await broker.close()
    expect(messages).toContainEqual({ type: 'copy-exit', token: 'bad' })
  } finally {
    await broker.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
