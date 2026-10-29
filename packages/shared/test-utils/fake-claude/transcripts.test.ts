import { describe, expect, it } from 'vitest'
import { listTranscripts, readTranscript } from './transcript'

// Recorded real-CLI runs are committed fixtures: they must carry no personal data,
// and must stay in the shape the fake's replay and the drift check read.
const transcripts = listTranscripts()

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const UUID_ARG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('recorded claude transcripts', () => {
  it('exist', () => {
    expect(transcripts.length).toBeGreaterThan(0)
  })

  for (const { recipe, file } of transcripts) {
    describe(recipe, () => {
      const records = readTranscript(file)
      const text = JSON.stringify(records)

      it('starts with a header naming its recipe and CLI version', () => {
        expect(records[0]).toMatchObject({
          kind: 'header',
          recipe,
          cliVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/)
        })
      })

      it('has a process record before any I/O, and an exit per process', () => {
        expect(records[1]?.kind).toBe('process')
        const processes = records.filter((r) => r.kind === 'process').length
        expect(records.filter((r) => r.kind === 'exit')).toHaveLength(processes)
      })

      it('every stdin/stdout line is one JSON object', () => {
        for (const r of records) {
          if (r.kind === 'stdin' || r.kind === 'stdout')
            expect(() => JSON.parse(r.line)).not.toThrow()
        }
      })

      it('carries no personal or machine-specific data', () => {
        expect(text).not.toMatch(/\/Users\/(?!user\b)/)
        expect(text).not.toMatch(/\/home\/(?!user\b)/)
        expect(text).not.toMatch(/var[/-]folders/)
        expect((text.match(EMAIL) ?? []).filter((m) => !m.endsWith('@example.com'))).toEqual([])
      })

      it('stores session ids as {{sessionId}} so a replay echoes the live one', () => {
        for (const r of records) {
          if (r.kind !== 'process') continue
          const at = r.argv.findIndex((a) => a === '--session-id' || a === '--resume')
          expect(r.argv[at + 1]).toBe('{{sessionId}}')
          expect(r.argv[at + 1]).not.toMatch(UUID_ARG)
        }
      })
    })
  }
})
