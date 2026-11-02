import Database from 'better-sqlite3'
import { expect, test } from 'vitest'
import { createSlayzoneDbAdapter } from '../../../shared/test-utils/ipc-harness'
import { createLegacyChatDiagnostics } from './chat-diagnostics'

test('diagnostic migration fences retention until copied; cleanup keeps metadata only', async () => {
  const raw = new Database(':memory:')
  try {
    raw.exec(
      'CREATE TABLE diagnostics_events(id TEXT PRIMARY KEY,task_id TEXT,event TEXT,message TEXT,payload_json TEXT,ts_ms INTEGER)'
    )
    raw
      .prepare('INSERT INTO diagnostics_events VALUES(?,?,?,?,?,?)')
      .run(
        'd',
        't',
        'pty.hook_received',
        'private prompt',
        JSON.stringify({ raw: { prompt: 'private marker' } }),
        123
      )
    const source = createLegacyChatDiagnostics({ db: createSlayzoneDbAdapter(raw) })
    const cutoff = await source.freeze('t'),
      records = []
    expect(() => raw.exec('DELETE FROM diagnostics_events')).toThrow(/migration/i)
    for await (const r of source.records('t', cutoff)) records.push(r)
    expect(records).toMatchObject([
      {
        id: 'diagnostic:d',
        value: {
          message: 'private prompt',
          payload_json: expect.stringContaining('private marker')
        }
      }
    ])
    await source.cleanup('t', cutoff)
    expect(raw.prepare('SELECT event,message,payload_json FROM diagnostics_events').get()).toEqual({
      event: 'pty.hook_received',
      message: '',
      payload_json: null
    })
    expect(() => raw.exec('DELETE FROM diagnostics_events')).not.toThrow()
  } finally {
    raw.close()
  }
})
