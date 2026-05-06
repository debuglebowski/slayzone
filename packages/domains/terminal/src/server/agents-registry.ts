import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentInfo, AgentSource } from '../shared/types'
import { parseFrontmatter } from './frontmatter'

async function scanDir(root: string, source: AgentSource): Promise<AgentInfo[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }
  const out: AgentInfo[] = []
  await Promise.all(
    entries.map(async (file) => {
      if (!file.endsWith('.md')) return
      const agentPath = path.join(root, file)
      let text: string
      try {
        const stat = await fs.stat(agentPath)
        if (!stat.isFile()) return
        text = await fs.readFile(agentPath, 'utf-8')
      } catch {
        return
      }
      const fm = parseFrontmatter(text)
      const name = fm.name ?? file.replace(/\.md$/, '')
      const description = fm.description ?? ''
      out.push({ name, description, source, path: agentPath })
    })
  )
  return out
}

/**
 * List subagent definitions from:
 *   - $HOME/.claude/agents   (user)
 *   - <cwd>/.claude/agents   (project)
 *
 * Precedence: project > user. Sorted by name.
 */
export async function listAgents(cwd: string): Promise<AgentInfo[]> {
  const [user, project] = await Promise.all([
    scanDir(path.join(os.homedir(), '.claude', 'agents'), 'user'),
    scanDir(path.join(cwd, '.claude', 'agents'), 'project'),
  ])
  const byName = new Map<string, AgentInfo>()
  for (const a of user) byName.set(a.name, a)
  for (const a of project) byName.set(a.name, a)
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
}
