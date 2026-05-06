import { readdir, readFile, stat } from 'fs/promises'
import { createHash } from 'crypto'
import { join } from 'path'
import { homedir, platform } from 'os'
import type { UsageRecord } from '../../shared/types'
import type { ParseResult } from './claude'

interface OpenCodeMessage {
  id?: string
  sessionID?: string
  modelID?: string
  time?: { created?: string }
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

function getOpenCodeStorageDir(): string {
  if (process.env.OPENCODE_DATA_DIR) {
    return join(process.env.OPENCODE_DATA_DIR, 'storage', 'message')
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'opencode', 'storage', 'message')
  }
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(xdg, 'opencode', 'storage', 'message')
}

export async function parseOpenCodeFiles(
  getLastOffset: (filePath: string) => { offset: number; modifiedMs: number } | undefined
): Promise<ParseResult[]> {
  const messageDir = getOpenCodeStorageDir()
  const results: ParseResult[] = []

  let files: string[]
  try {
    files = (await readdir(messageDir)).filter((f) => f.endsWith('.json'))
  } catch {
    return results
  }

  for (const file of files) {
    const filePath = join(messageDir, file)
    const fileStat = await stat(filePath).catch(() => null)
    if (!fileStat) continue

    const lastState = getLastOffset(filePath)
    if (lastState && fileStat.mtimeMs <= lastState.modifiedMs) continue

    let msg: OpenCodeMessage
    try {
      const raw = await readFile(filePath, 'utf-8')
      msg = JSON.parse(raw)
    } catch {
      continue
    }

    const tokens = msg.tokens
    if (!tokens || (!tokens.input && !tokens.output)) continue

    const id = msg.id
      ? createHash('md5').update(`opencode:${msg.id}`).digest('hex')
      : createHash('md5').update(`opencode:${file}`).digest('hex')

    const records: UsageRecord[] = [
      {
        id,
        provider: 'opencode',
        model: msg.modelID ?? 'unknown',
        sessionId: msg.sessionID ?? null,
        timestamp: msg.time?.created ?? new Date().toISOString(),
        inputTokens: tokens.input ?? 0,
        outputTokens: tokens.output ?? 0,
        cacheReadTokens: tokens.cache?.read ?? 0,
        cacheWriteTokens: tokens.cache?.write ?? 0,
        reasoningTokens: tokens.reasoning ?? 0,
        cwd: null,
        taskId: null
      }
    ]

    results.push({ records, sourceFile: filePath, fileMtimeMs: fileStat.mtimeMs, endOffset: fileStat.size })
  }

  return results
}
