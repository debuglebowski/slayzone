/**
 * Recorded real `codex app-server` transcripts: where they live, plus the shared
 * format and readers (test-utils/fake-cli/transcript.ts). One stdin/stdout record
 * per JSON-RPC line. Thread ids, turn ids and the cwd are stored as `{{threadId}}`,
 * `{{turnId}}` and `{{cwd}}`. Recorded by
 * packages/domains/terminal/src/server/agents/codex/codex-app-server-recorder.live.ts,
 * redacted before they are kept.
 *
 * @module test-utils/fake-codex/transcript
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transcriptReaders } from '../fake-cli/transcript'

export {
  readTranscript,
  transcriptStdout,
  type TranscriptRecord
} from '../fake-cli/transcript'

export const CODEX_TRANSCRIPTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'transcripts'
)

export const { transcriptPath: codexTranscriptPath, listTranscripts: listCodexTranscripts } =
  transcriptReaders(CODEX_TRANSCRIPTS_DIR)
