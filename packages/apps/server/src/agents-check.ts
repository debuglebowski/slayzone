import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { platform } from 'node:os'

export interface AgentProbeResult {
  name: string
  found: boolean
  path: string | null
}

export const KNOWN_AGENTS = [
  'claude',
  'codex',
  'gemini',
  'aider',
  'qwen',
  'opencode',
  'copilot',
  'cursor',
] as const

export function whichSync(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const PATH = env.PATH || env.Path || ''
  if (!PATH) return null
  const isWin = platform() === 'win32'
  const exts = isWin
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext.toLowerCase())
      const candidateUpper = join(dir, cmd + ext)
      for (const p of new Set([candidate, candidateUpper])) {
        try {
          const st = statSync(p)
          if (!st.isFile()) continue
          if (!isWin) accessSync(p, constants.X_OK)
          return p
        } catch {
          /* try next */
        }
      }
    }
  }
  return null
}

export function probeAgents(
  agents: readonly string[] = KNOWN_AGENTS,
  env: NodeJS.ProcessEnv = process.env,
): AgentProbeResult[] {
  return agents.map((name) => {
    const path = whichSync(name, env)
    return { name, found: path != null, path }
  })
}
