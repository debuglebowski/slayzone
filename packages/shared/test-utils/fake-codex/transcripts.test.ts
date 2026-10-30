import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { readCodexProtocolSurface } from './protocol'
import { listCodexTranscripts, readTranscript } from './transcript'

// Recorded real `codex app-server` runs are committed fixtures: they must carry no
// personal data, must stay in the shape the fake's replay and the drift check
// read, and must come from the CLI version the protocol surface pins.
const transcripts = listCodexTranscripts()
const surface = readCodexProtocolSurface()

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

describe('recorded codex app-server transcripts', () => {
  it('exist', () => {
    expect(transcripts.length).toBeGreaterThan(0)
  })

  for (const { recipe, file } of transcripts) {
    describe(recipe, () => {
      const records = readTranscript(file)
      const text = JSON.stringify(records)
      const lines = records.flatMap((r) =>
        r.kind === 'stdin' || r.kind === 'stdout'
          ? [{ dir: r.kind, msg: JSON.parse(r.line) as Record<string, unknown> }]
          : []
      )

      it('starts with a header naming its recipe and the pinned CLI version', () => {
        expect(records[0]).toMatchObject({ kind: 'header', recipe, cliVersion: surface.cliVersion })
      })

      it('has a process record before any I/O, and an exit per process', () => {
        expect(records[1]?.kind).toBe('process')
        const processes = records.filter((r) => r.kind === 'process')
        expect(records.filter((r) => r.kind === 'exit')).toHaveLength(processes.length)
        for (const p of processes) expect(p.argv[0]).toBe('app-server')
      })

      it('every stdin/stdout line is one JSON-RPC object', () => {
        for (const { msg } of lines) expect(typeof msg).toBe('object')
      })

      it('carries no personal or machine-specific data', () => {
        expect(text).not.toMatch(/\/Users\/(?!user\b)/)
        expect(text).not.toMatch(/\/home\/(?!user\b)/)
        expect(text).not.toMatch(/var[/-]folders/)
        expect(text).not.toMatch(/scratchpad/)
        expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./)
        expect(text.toLowerCase()).not.toContain(os.hostname().toLowerCase())
        const user = os.userInfo().username
        if (user.length > 2) expect(text.toLowerCase()).not.toContain(user.toLowerCase())
        expect((text.match(EMAIL) ?? []).filter((m) => !m.endsWith('@example.com'))).toEqual([])
      })

      it('stores thread and turn ids as {{threadId}} / {{turnId}}, so a replay echoes the live ones', () => {
        for (const { msg } of lines) {
          const params = msg.params as Record<string, unknown> | undefined
          if (typeof params?.threadId === 'string') expect(params.threadId).toBe('{{threadId}}')
          if (typeof params?.turnId === 'string') expect(params.turnId).toBe('{{turnId}}')
          const thread = (msg.result as { thread?: { id?: string } } | undefined)?.thread
          if (thread?.id) expect(thread.id).not.toMatch(UUID)
        }
      })
    })
  }
})
