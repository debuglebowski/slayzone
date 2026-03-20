import { createReadStream } from 'fs'
import { readdir, stat } from 'fs/promises'
import { createInterface } from 'readline'
import { createHash } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'
import type { UsageRecord } from '../../shared/types'

interface ClaudeAssistantEntry {
  type: 'assistant'
  sessionId?: string
  timestamp?: string
  requestId?: string
  cwd?: string
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

function getClaudeProjectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(configDir, 'projects')
}

function dedupId(messageId: string | undefined, requestId: string | undefined): string {
  const raw = `${messageId ?? ''}:${requestId ?? ''}`
  return createHash('md5').update(raw).digest('hex')
}

export interface ParseResult {
  records: UsageRecord[]
  sourceFile: string
  fileMtimeMs: number
  endOffset: number
}

export async function parseClaudeFiles(
  getLastOffset: (filePath: string) => { offset: number; modifiedMs: number } | undefined
): Promise<ParseResult[]> {
  const projectsDir = getClaudeProjectsDir()
  const results: ParseResult[] = []

  let projectDirs: string[]
  try {
    projectDirs = await readdir(projectsDir)
  } catch {
    return results
  }

  for (const dir of projectDirs) {
    const dirPath = join(projectsDir, dir)
    const dirStat = await stat(dirPath).catch(() => null)
    if (!dirStat?.isDirectory()) continue

    let files: string[]
    try {
      files = (await readdir(dirPath)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }

    for (const file of files) {
      const filePath = join(dirPath, file)
      const fileStat = await stat(filePath).catch(() => null)
      if (!fileStat) continue

      const lastState = getLastOffset(filePath)
      if (lastState && fileStat.mtimeMs <= lastState.modifiedMs) continue

      const records: UsageRecord[] = []
      const startOffset = lastState?.offset ?? 0

      const endOffset = await new Promise<number>((resolve, reject) => {
        const stream = createReadStream(filePath, { start: startOffset, encoding: 'utf-8' })
        const rl = createInterface({ input: stream, crlfDelay: Infinity })

        rl.on('line', (line) => {

          let entry: ClaudeAssistantEntry
          try {
            entry = JSON.parse(line)
          } catch {
            return
          }

          if (entry.type !== 'assistant') return
          const usage = entry.message?.usage
          if (!usage) return

          records.push({
            id: dedupId(entry.message?.id, entry.requestId),
            provider: 'claude-code',
            model: entry.message?.model ?? 'unknown',
            sessionId: entry.sessionId ?? null,
            timestamp: entry.timestamp ?? new Date().toISOString(),
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            reasoningTokens: 0,
            cwd: entry.cwd ?? null,
            taskId: null
          })
        })

        rl.on('close', () => resolve(startOffset + stream.bytesRead))
        rl.on('error', reject)
        stream.on('error', reject)
      })

      results.push({ records, sourceFile: filePath, fileMtimeMs: fileStat.mtimeMs, endOffset })
    }
  }

  return results
}
