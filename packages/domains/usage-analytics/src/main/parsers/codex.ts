import { createReadStream } from 'fs'
import { readdir, stat } from 'fs/promises'
import { createInterface } from 'readline'
import { createHash } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'
import type { UsageRecord } from '../../shared/types'
import type { ParseResult } from './claude'

interface CodexEntry {
  timestamp?: string
  type?: string
  payload?: {
    type?: string
    id?: string
    cwd?: string
    model?: string
    turn_id?: string
    info?: {
      total_token_usage?: {
        input_tokens?: number
        output_tokens?: number
        cached_input_tokens?: number
        reasoning_output_tokens?: number
        total_tokens?: number
      }
      last_token_usage?: {
        input_tokens?: number
        output_tokens?: number
        cached_input_tokens?: number
        reasoning_output_tokens?: number
        total_tokens?: number
      }
    }
  }
}

function getCodexSessionsDir(): string {
  return join(homedir(), '.codex', 'sessions')
}

export async function parseCodexFiles(
  getLastOffset: (filePath: string) => { offset: number; modifiedMs: number } | undefined
): Promise<ParseResult[]> {
  const sessionsDir = getCodexSessionsDir()
  const results: ParseResult[] = []

  const jsonlFiles: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      const s = await stat(fullPath).catch(() => null)
      if (!s) continue
      if (s.isDirectory()) await walk(fullPath)
      else if (entry.endsWith('.jsonl')) jsonlFiles.push(fullPath)
    }
  }

  try {
    await walk(sessionsDir)
  } catch {
    return results
  }

  for (const filePath of jsonlFiles) {
    const fileStat = await stat(filePath).catch(() => null)
    if (!fileStat) continue

    const lastState = getLastOffset(filePath)
    if (lastState && fileStat.mtimeMs <= lastState.modifiedMs) continue

    let sessionId: string | null = null
    let cwd: string | null = null
    let currentModel: string = 'unknown'

    const records: UsageRecord[] = []
    const startOffset = lastState?.offset ?? 0

    const endOffset = await new Promise<number>((resolve, reject) => {
      const stream = createReadStream(filePath, { start: startOffset, encoding: 'utf-8' })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })

      rl.on('line', (line) => {

        let entry: CodexEntry
        try {
          entry = JSON.parse(line)
        } catch {
          return
        }

        if (entry.type === 'session_meta' && entry.payload) {
          sessionId = entry.payload.id ?? null
          cwd = entry.payload.cwd ?? null
        }

        if (entry.type === 'turn_context' && entry.payload?.model) {
          currentModel = entry.payload.model
        }

        if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
          // Use last_token_usage (per-turn delta), not total_token_usage (cumulative)
          const usage = entry.payload.info?.last_token_usage ?? entry.payload.info?.total_token_usage
          if (!usage) return

          const turnId = entry.payload.turn_id ?? entry.timestamp ?? ''
          const id = createHash('md5').update(`codex:${sessionId}:${turnId}:${entry.timestamp}`).digest('hex')

          records.push({
            id,
            provider: 'codex',
            model: currentModel,
            sessionId,
            timestamp: entry.timestamp ?? new Date().toISOString(),
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cached_input_tokens ?? 0,
            cacheWriteTokens: 0,
            reasoningTokens: usage.reasoning_output_tokens ?? 0,
            cwd,
            taskId: null
          })
        }
      })

      rl.on('close', () => resolve(startOffset + stream.bytesRead))
      rl.on('error', reject)
      stream.on('error', reject)
    })

    results.push({ records, sourceFile: filePath, fileMtimeMs: fileStat.mtimeMs, endOffset })
  }

  return results
}
