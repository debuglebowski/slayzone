/**
 * Recorded real `claude` transcripts: where they live, plus the shared format and
 * readers (test-utils/fake-cli/transcript.ts). Session ids and the cwd are stored
 * as `{{sessionId}}` / `{{cwd}}`. Recorded by
 * packages/domains/terminal/src/server/agents/claude-stream-recorder.live.ts,
 * redacted before they are kept.
 *
 * @module test-utils/fake-claude/transcript
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transcriptReaders } from '../fake-cli/transcript'

export {
  readTranscript,
  transcriptStdout,
  type TranscriptRecord
} from '../fake-cli/transcript'

export const TRANSCRIPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'transcripts'
)

export const { transcriptPath, listTranscripts } = transcriptReaders(TRANSCRIPTS_DIR)
