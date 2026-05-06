import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SkillInfo, SkillSource } from '../shared/types'
import { parseFrontmatter } from './frontmatter'

async function scanDir(root: string, source: SkillSource): Promise<SkillInfo[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }
  const out: SkillInfo[] = []
  await Promise.all(
    entries.map(async (dir) => {
      const skillPath = path.join(root, dir, 'SKILL.md')
      let text: string
      try {
        text = await fs.readFile(skillPath, 'utf-8')
      } catch {
        return
      }
      const fm = parseFrontmatter(text)
      const name = fm.name ?? dir
      const description = fm.description ?? ''
      out.push({ name, description, source, path: skillPath })
    })
  )
  return out
}

/**
 * List available skills from:
 *   - $HOME/.claude/skills          (user)
 *   - <cwd>/.claude/skills          (project)
 *   - <cwd>/.agents/skills          (agents)
 *
 * Precedence: project > agents > user. Sorted by name.
 */
export async function listSkills(cwd: string): Promise<SkillInfo[]> {
  const [user, project, agents] = await Promise.all([
    scanDir(path.join(os.homedir(), '.claude', 'skills'), 'user'),
    scanDir(path.join(cwd, '.claude', 'skills'), 'project'),
    scanDir(path.join(cwd, '.agents', 'skills'), 'agents'),
  ])
  const byName = new Map<string, SkillInfo>()
  for (const s of user) byName.set(s.name, s)
  for (const s of agents) byName.set(s.name, s)
  for (const s of project) byName.set(s.name, s)
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
}

// Re-export for existing test import.
export { parseFrontmatter } from './frontmatter'
export type { Frontmatter as SkillFrontmatter } from './frontmatter'
