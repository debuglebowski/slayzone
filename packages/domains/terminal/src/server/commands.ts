import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CommandInfo, CommandSource } from '../shared/types'
import { parseFrontmatter } from './frontmatter'

async function scanDir(root: string, source: CommandSource): Promise<CommandInfo[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }
  const out: CommandInfo[] = []
  await Promise.all(
    entries.map(async (file) => {
      if (!file.endsWith('.md')) return
      const cmdPath = path.join(root, file)
      let text: string
      try {
        const stat = await fs.stat(cmdPath)
        if (!stat.isFile()) return
        text = await fs.readFile(cmdPath, 'utf-8')
      } catch {
        return
      }
      const fm = parseFrontmatter(text)
      const name = fm.name ?? file.replace(/\.md$/, '')
      const description = fm.description ?? ''
      out.push({ name, description, source, path: cmdPath, body: fm.body.trim() })
    })
  )
  return out
}

/**
 * List custom slash commands from:
 *   - $HOME/.claude/commands     (user)
 *   - <cwd>/.claude/commands     (project)
 *
 * Precedence: project > user. Sorted by name.
 */
export async function listCommands(cwd: string): Promise<CommandInfo[]> {
  const [user, project] = await Promise.all([
    scanDir(path.join(os.homedir(), '.claude', 'commands'), 'user'),
    scanDir(path.join(cwd, '.claude', 'commands'), 'project'),
  ])
  const byName = new Map<string, CommandInfo>()
  for (const c of user) byName.set(c.name, c)
  for (const c of project) byName.set(c.name, c)
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
}
