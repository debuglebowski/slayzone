import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CommandInfo, CommandSource } from '@slayzone/terminal-contracts'
import { parseFrontmatter } from './frontmatter'

/** Sub-folder depth a nested scan follows (`a/b/c/d.md` → `a:b:c:d`). */
const MAX_NESTED_DEPTH = 4

async function readCommand(
  cmdPath: string,
  namespace: string[],
  file: string,
  source: CommandSource
): Promise<CommandInfo | null> {
  let text: string
  try {
    const stat = await fs.stat(cmdPath)
    if (!stat.isFile()) return null
    text = await fs.readFile(cmdPath, 'utf-8')
  } catch {
    return null
  }
  const fm = parseFrontmatter(text)
  const cliName = [...namespace, file.replace(/\.md$/, '')].join(':')
  return {
    name: fm.name ?? cliName,
    description: fm.description ?? '',
    source,
    path: cmdPath,
    cliName,
    ...(fm.argumentHint ? { argumentHint: fm.argumentHint } : {}),
    body: fm.body.trim()
  }
}

async function scanDir(
  root: string,
  source: CommandSource,
  nested: boolean,
  namespace: string[] = []
): Promise<CommandInfo[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = await Promise.all(
    entries.map(async (entry): Promise<CommandInfo[]> => {
      const entryPath = path.join(root, entry.name)
      if (entry.isDirectory()) {
        if (!nested || namespace.length >= MAX_NESTED_DEPTH) return []
        return scanDir(entryPath, source, nested, [...namespace, entry.name])
      }
      if (!entry.name.endsWith('.md')) return []
      const cmd = await readCommand(entryPath, namespace, entry.name, source)
      return cmd ? [cmd] : []
    })
  )
  return found.flat()
}

/**
 * List custom slash commands from:
 *   - $HOME/.claude/commands     (user)
 *   - <cwd>/.claude/commands     (project)
 *
 * Precedence: project > user. Sorted by name.
 * `nested` also lists commands in sub-folders, named the way the Claude CLI
 * runs them (`sub/z.md` → `sub:z`).
 */
export async function listCommands(
  cwd: string,
  opts: { nested?: boolean } = {}
): Promise<CommandInfo[]> {
  const nested = opts.nested === true
  const [user, project] = await Promise.all([
    scanDir(path.join(os.homedir(), '.claude', 'commands'), 'user', nested),
    scanDir(path.join(cwd, '.claude', 'commands'), 'project', nested)
  ])
  const byName = new Map<string, CommandInfo>()
  for (const c of user) byName.set(c.name, c)
  for (const c of project) byName.set(c.name, c)
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
}
