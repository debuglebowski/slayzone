/**
 * Recorded real-CLI transcripts, shared by the fakes (fake-claude, fake-codex):
 * the record format and readers over one transcripts dir.
 *
 * A transcript is JSON Lines. The first record is a header, then one record per
 * thing that crossed the CLI's pipes, in order:
 *
 *   {"kind":"header","recipe":"…","cliVersion":"…","model":"…","recordedAt":"2026-10-29"}
 *   {"kind":"process","index":0,"argv":[…]}            ← one per spawned CLI
 *   {"kind":"stdin","t":12,"line":"{…}"}               ← what the host wrote
 *   {"kind":"stdout","t":480,"line":"{…}"}             ← one line the CLI printed
 *   {"kind":"stderr","t":500,"text":"…"}
 *   {"kind":"exit","t":900,"code":0,"signal":null}
 *
 * `t` = ms since that process started. Ids and the cwd are stored as the fake's
 * template vars (`{{sessionId}}`, `{{cwd}}`, …), so a replay echoes live values.
 *
 * @module test-utils/fake-cli/transcript
 */
import fs from 'node:fs'
import path from 'node:path'

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

export interface TranscriptReaders {
  /** Absolute path of a recorded transcript, by recipe name. Throws when missing. */
  transcriptPath(recipe: string): string
  /** Every recorded transcript (recipe name → absolute path), sorted. */
  listTranscripts(): Array<{ recipe: string; file: string }>
}

export function transcriptReaders(dir: string): TranscriptReaders {
  return {
    transcriptPath(recipe) {
      const file = path.join(dir, `${recipe}.jsonl`)
      if (!fs.existsSync(file)) throw new Error(`no recorded transcript '${recipe}' in ${dir}`)
      return file
    },
    listTranscripts() {
      if (!fs.existsSync(dir)) return []
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .sort()
        .map((f) => ({ recipe: f.slice(0, -'.jsonl'.length), file: path.join(dir, f) }))
    }
  }
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
