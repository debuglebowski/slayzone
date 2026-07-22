import { Command } from 'commander'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BUILTIN_SKILLS, PROVIDER_PATHS, defaultProviderFromMode } from '@slayzone/ai-config/shared'
import type { CliProvider } from '@slayzone/ai-config/shared'
import { openDb, notifyApp, resolveProject, resolveProjectByPath } from '../db'
import type { SlayDb } from '../db'

const INSTRUCTIONS = `\
# SlayZone Environment

You are an agent running inside a [SlayZone](https://slayzone.com) task. Other agents may be running in their own tasks in parallel, and a human or another agent can reach you through this terminal at any time.

## Interact with SlayZone

If useful, you have a toolbox for acting on SlayZone itself. You can:

- create and update tasks, and spawn sub-tasks with their own agents
- attach assets, run processes, open web panels, set up automations
- change your own task's state

The toolbox is the \`slay\` CLI. When you omit the task-id, most \`slay\` commands auto-resolve to your current task: \`$SLAYZONE_TASK_ID\` is used if set, otherwise the task bound to \`$SLAYZONE_SESSION_ID\` (always set in a task terminal) is looked up. Trust the resolution: just run the command, don't check or echo the env vars, and pass an explicit task-id only when you deliberately target a different task. **Load the \`slay\` skill before running any \`slay\` command** — it holds the full reference of commands, flags, and domain-specific guides. Never guess subcommands or flags.
`

type SkillStats = { installed: number; updated: number; skipped: number }

function loadProviders(db: SlayDb, projectId: string): CliProvider[] {
  const row = db.query<{ value: string }>(`SELECT value FROM settings WHERE key = :key`, {
    ':key': `ai_providers:${projectId}`
  })
  if (row.length > 0) {
    try {
      const parsed = JSON.parse(row[0].value)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as CliProvider[]
    } catch {
      /* fall through */
    }
  }

  const modeRow = db.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'default_terminal_mode'`
  )
  return [defaultProviderFromMode(modeRow[0]?.value)]
}

function writeInstructionsToDisk(projectPath: string, providers: CliProvider[]): string[] {
  const filenames = new Set<string>()
  for (const p of providers) {
    const f = PROVIDER_PATHS[p]?.rootInstructions
    if (f) filenames.add(f)
  }
  const written: string[] = []
  for (const filename of filenames) {
    const filePath = path.join(projectPath, filename)
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
    const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
    fs.appendFileSync(filePath, prefix + INSTRUCTIONS, 'utf-8')
    written.push(filename)
  }
  return written
}

function installSkills(
  db: SlayDb,
  projectId: string,
  projectPath: string | null,
  providers: CliProvider[]
): SkillStats {
  const registryId = 'builtin-slayzone'
  const syncedSkills: { slug: string; content: string }[] = []
  const stats: SkillStats = { installed: 0, updated: 0, skipped: 0 }

  for (const skill of BUILTIN_SKILLS) {
    const entryId = `builtin-${skill.slug}`
    const hash = createHash('sha256').update(skill.content).digest('hex')
    const now = new Date().toISOString()

    const existing = db.query<{ id: string; metadata_json: string }>(
      `SELECT id, metadata_json FROM ai_config_items WHERE type = 'skill' AND slug = :slug AND scope = 'project' AND project_id = :projectId`,
      { ':slug': skill.slug, ':projectId': projectId }
    )

    if (existing.length > 0) {
      const existingMeta = JSON.parse(existing[0].metadata_json || '{}') as {
        marketplace?: { installedVersion?: string; [key: string]: unknown }
        [key: string]: unknown
      }
      if (existingMeta.marketplace?.installedVersion === hash) {
        stats.skipped++
        continue
      }

      const metadata = {
        ...existingMeta,
        marketplace: {
          ...(existingMeta.marketplace ?? {}),
          registryId,
          registryName: 'SlayZone Built-in',
          entryId,
          installedVersion: hash,
          installedAt: now
        }
      }

      db.run(
        `UPDATE ai_config_items SET content = :content, metadata_json = :metadata, updated_at = :now WHERE id = :id`,
        {
          ':content': skill.content,
          ':metadata': JSON.stringify(metadata),
          ':now': now,
          ':id': existing[0].id
        }
      )
      syncedSkills.push({ slug: skill.slug, content: skill.content })
      stats.updated++
      console.log(`  Updated ${skill.name}`)
      continue
    }

    const id = crypto.randomUUID()

    const metadata = {
      marketplace: {
        registryId,
        registryName: 'SlayZone Built-in',
        entryId,
        installedVersion: hash,
        installedAt: now
      }
    }

    db.run(
      `INSERT INTO ai_config_items (id, type, scope, project_id, name, slug, content, metadata_json, created_at, updated_at)
       VALUES (:id, 'skill', 'project', :projectId, :name, :slug, :content, :metadata, :now, :now)`,
      {
        ':id': id,
        ':projectId': projectId,
        ':name': skill.name,
        ':slug': skill.slug,
        ':content': skill.content,
        ':metadata': JSON.stringify(metadata),
        ':now': now
      }
    )
    syncedSkills.push({ slug: skill.slug, content: skill.content })
    stats.installed++
    console.log(`  Installed ${skill.name}`)
  }

  if (projectPath && syncedSkills.length > 0) {
    for (const provider of providers) {
      const mapping = PROVIDER_PATHS[provider]
      if (!mapping?.skillsDir) continue
      for (const skill of syncedSkills) {
        const filePath = path.join(projectPath, mapping.skillsDir, skill.slug, 'SKILL.md')
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        fs.writeFileSync(filePath, skill.content, 'utf-8')
      }
    }
  }

  return stats
}

function logSkillStats(stats: SkillStats, projectName: string): void {
  if (stats.installed + stats.updated > 0) {
    const parts: string[] = []
    if (stats.installed > 0) parts.push(`installed ${stats.installed}`)
    if (stats.updated > 0) parts.push(`updated ${stats.updated}`)
    if (stats.skipped > 0) parts.push(`${stats.skipped} unchanged`)
    console.log(`\n${parts.join(', ')} for "${projectName}"`)
  } else {
    console.log(`All ${stats.skipped} skills up to date for "${projectName}"`)
  }
}

async function runInstall(opts: { writeInstructions: boolean; project?: string }): Promise<void> {
  const db = openDb()
  const project = opts.project
    ? resolveProject(db, opts.project)
    : resolveProjectByPath(db, process.cwd())
  const providers = loadProviders(db, project.id)

  if (opts.writeInstructions && project.path) {
    const written = writeInstructionsToDisk(project.path, providers)
    for (const f of written) console.log(`  Appended instructions to ${f}`)
  }

  const stats = installSkills(db, project.id, project.path, providers)
  db.close()

  if (stats.installed + stats.updated > 0) await notifyApp()
  logSkillStats(stats, project.name)
}

export function initCommand(): Command {
  const cmd = new Command('init')
    .description('Bootstrap SlayZone agent config (instructions + skills) for the current project')
    .option('-p, --project <name|id>', 'Project name or ID (defaults to project resolved from cwd)')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)
    .action((opts) => runInstall({ writeInstructions: true, project: opts.project }))

  cmd
    .command('instructions')
    .description('Print CLAUDE.md / AGENTS.md template')
    .action(() => {
      process.stdout.write(INSTRUCTIONS)
    })

  cmd
    .command('skills')
    .description('Install all built-in slay skills for the current project')
    .option('-p, --project <name|id>', 'Project name or ID (defaults to project resolved from cwd)')
    .action((opts) => runInstall({ writeInstructions: false, project: opts.project }))

  return cmd
}
