import { Command } from 'commander'
import { createHash } from 'node:crypto'
import { BUILTIN_SKILLS } from '@slayzone/ai-config/shared'
import { openDb, notifyApp } from '../db'

const INSTRUCTIONS = `\
# SlayZone Environment

You are running inside [SlayZone](https://slayzone.com), a desktop development environment built around a kanban board. Each task on the board is a full workspace with terminal panels, a file editor, a browser panel, and git integration. Your session is one of potentially many agents working in parallel on different tasks. A human or another agent may interact with you through the terminal.

Your task has a title, description, status, and subtasks — use the \`slay\` CLI to read and update them. See the \`slay\` skill for the full command reference.

\`$SLAYZONE_TASK_ID\` is set to the ID of the task you are running inside. Most \`slay\` commands default to it when no explicit ID is given.
`

export function initCommand(): Command {
  const cmd = new Command('init').description('Print SlayZone templates for AI agent configuration')

  cmd
    .command('instructions')
    .description('Print CLAUDE.md / AGENTS.md template')
    .action(() => {
      process.stdout.write(INSTRUCTIONS)
    })

  cmd
    .command('skills')
    .description('Install all built-in slay skills from the marketplace registry')
    .action(async () => {
      const db = openDb()
      const registryId = 'builtin-slayzone'

      let installed = 0
      let skipped = 0

      for (const skill of BUILTIN_SKILLS) {
        const entryId = `builtin-${skill.slug}`
        const hash = createHash('sha256').update(skill.content).digest('hex')

        // Check if already installed by slug
        const existing = db.query<{ id: string }>(
          `SELECT id FROM ai_config_items WHERE type = 'skill' AND slug = :slug AND scope = 'global'`,
          { ':slug': skill.slug }
        )

        if (existing.length > 0) {
          skipped++
          continue
        }

        const id = crypto.randomUUID()
        const now = new Date().toISOString()

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
           VALUES (:id, 'skill', 'global', NULL, :name, :slug, :content, :metadata, :now, :now)`,
          {
            ':id': id,
            ':name': skill.name,
            ':slug': skill.slug,
            ':content': skill.content,
            ':metadata': JSON.stringify(metadata),
            ':now': now,
          }
        )
        installed++
        console.log(`  Installed ${skill.name}`)
      }

      db.close()

      if (installed > 0) {
        await notifyApp()
        console.log(`\nInstalled ${installed} skill${installed === 1 ? '' : 's'}${skipped > 0 ? `, ${skipped} already installed` : ''}`)
      } else {
        console.log(`All ${skipped} skills already installed`)
      }
    })

  return cmd
}
