import { createReadStream } from 'fs'
import { readdir, stat } from 'fs/promises'
import { createInterface } from 'readline'
import { createHash } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'
import type { UsageRecord } from '../../shared/types'
import type { ParseResult } from './claude'

// Qwen Code stores sessions under ~/.qwen/projects/<project-name>/chats/*.jsonl
// Format uses Google Gemini-style usageMetadata (not Anthropic message.usage)
interface QwenAssistantEntry {
  type: 'assistant'
  uuid?: string
  sessionId?: string
  timestamp?: string
  cwd?: string
  model?: string
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    cachedContentTokenCount?: number
  }
}

function getQwenProjectsDir(): string {
  const configDir = process.env.QWEN_CONFIG_DIR || join(homedir(), '.qwen')
  return join(configDir, 'projects')
}

export async function parseQwenFiles(
  getLastOffset: (filePath: string) => { offset: number; modifiedMs: number } | undefined
): Promise<ParseResult[]> {
  const projectsDir = getQwenProjectsDir()
  const results: ParseResult[] = []

  let projectDirs: string[]
  try {
    projectDirs = await readdir(projectsDir)
  } catch {
    return results
  }

  for (const dir of projectDirs) {
    // Qwen uses <project>/chats/*.jsonl — one extra level vs Claude
    const chatsDir = join(projectsDir, dir, 'chats')
    const chatsDirStat = await stat(chatsDir).catch(() => null)
    if (!chatsDirStat?.isDirectory()) continue

    let files: string[]
    try {
      files = (await readdir(chatsDir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }

    for (const file of files) {
      const filePath = join(chatsDir, file)
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

          let entry: QwenAssistantEntry
          try {
            entry = JSON.parse(line)
          } catch {
            return
          }

          if (entry.type !== 'assistant') return
          const usage = entry.usageMetadata
          if (!usage) return

          const baseKey = `qwen:${entry.uuid ?? ''}:${entry.sessionId ?? ''}:${entry.timestamp ?? ''}`
          const idKey = (entry.uuid || entry.sessionId || entry.timestamp)
            ? baseKey
            : `qwen:fallback:${filePath}:${startOffset + stream.bytesRead}:${line}`
          const id = createHash('md5').update(idKey).digest('hex')

          records.push({
            id,
            provider: 'qwen-code',
            model: entry.model ?? 'unknown',
            sessionId: entry.sessionId ?? null,
            timestamp: entry.timestamp ?? new Date().toISOString(),
            inputTokens: usage.promptTokenCount ?? 0,
            outputTokens: usage.candidatesTokenCount ?? 0,
            cacheReadTokens: usage.cachedContentTokenCount ?? 0,
            cacheWriteTokens: 0,
            reasoningTokens: usage.thoughtsTokenCount ?? 0,
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
