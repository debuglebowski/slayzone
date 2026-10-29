/**
 * Recorded real-CLI transcripts: the format, and readers for tests.
 *
 * A transcript is JSON Lines. The first record is a header, then one record per
 * thing that crossed the CLI's pipes, in order:
 *
 *   {"kind":"header","recipe":"…","cliVersion":"2.1.312","model":"haiku","recordedAt":"2026-10-29"}
 *   {"kind":"process","index":0,"argv":["-p",…]}      ← one per spawned CLI
 *   {"kind":"stdin","t":12,"line":"{…}"}               ← what the host wrote
 *   {"kind":"stdout","t":480,"line":"{…}"}             ← one stream-json event
 *   {"kind":"stderr","t":500,"text":"…"}
 *   {"kind":"exit","t":900,"code":0,"signal":null}
 *
 * `t` = ms since that process started. Session ids and the cwd are stored as the
 * fake's template vars (`{{sessionId}}`, `{{cwd}}`), so a replay echoes the live
 * values. Recorded by packages/domains/terminal/src/server/agents/claude-stream-recorder.live.ts,
 * redacted before they are kept.
 *
 * @module test-utils/fake-claude/transcript
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const TRANSCRIPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'transcripts'
)

export type TranscriptRecord =
  | {
      kind: 'header'
      recipe: string
      cliVersion: string
      model: string
      recordedAt: string
      note?: string
    }
  | { kind: 'process'; index: number; argv: string[] }
  | { kind: 'stdin'; t: number; line: string }
  | { kind: 'stdout'; t: number; line: string }
  | { kind: 'stderr'; t: number; text: string }
  | { kind: 'exit'; t: number; code: number | null; signal: string | null }

/** Absolute path of a recorded transcript, by recipe name. Throws when missing. */
export function transcriptPath(recipe: string): string {
  const file = path.join(TRANSCRIPTS_DIR, `${recipe}.jsonl`)
  if (!fs.existsSync(file))
    throw new Error(`no recorded transcript '${recipe}' in ${TRANSCRIPTS_DIR}`)
  return file
}

/** Every recorded transcript (recipe name → absolute path), sorted. */
export function listTranscripts(): Array<{ recipe: string; file: string }> {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) return []
  return fs
    .readdirSync(TRANSCRIPTS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => ({ recipe: f.slice(0, -'.jsonl'.length), file: path.join(TRANSCRIPTS_DIR, f) }))
}

export function readTranscript(file: string): TranscriptRecord[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TranscriptRecord)
}

/** The stdout lines of a transcript (every process), in order. */
export function transcriptStdout(file: string): string[] {
  return readTranscript(file)
    .filter((r): r is Extract<TranscriptRecord, { kind: 'stdout' }> => r.kind === 'stdout')
    .map((r) => r.line)
}
