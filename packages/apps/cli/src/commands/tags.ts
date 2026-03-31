import { Command } from 'commander'
import { openDb, notifyApp, resolveProject } from '../db'

interface TagRow extends Record<string, unknown> {
  id: string
  name: string
  color: string
  text_color: string
  sort_order: number
  created_at: string
}

export function tagsCommand(): Command {
  const cmd = new Command('tags').description('Manage tags')

  // slay tags list
  cmd
    .command('list')
    .description('List tags for a project')
    .requiredOption('--project <name|id>', 'Project name or ID')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const db = openDb()
      const project = resolveProject(db, opts.project)

      const tags = db.query<TagRow>(
        `SELECT * FROM tags WHERE project_id = :pid ORDER BY sort_order, name`,
        { ':pid': project.id }
      )
      db.close()

      if (opts.json) {
        console.log(JSON.stringify(tags, null, 2))
        return
      }

      if (tags.length === 0) {
        console.log('No tags found.')
        return
      }

      const idW = 9
      const nameW = 20
      console.log(`${'ID'.padEnd(idW)}  ${'NAME'.padEnd(nameW)}  COLOR`)
      console.log(`${'-'.repeat(idW)}  ${'-'.repeat(nameW)}  ${'-'.repeat(7)}`)
      for (const t of tags) {
        const id = t.id.slice(0, 8).padEnd(idW)
        const name = t.name.slice(0, nameW).padEnd(nameW)
        console.log(`${id}  ${name}  ${t.color}`)
      }
    })

  // slay tags create
  cmd
    .command('create <name>')
    .description('Create a tag')
    .requiredOption('--project <name|id>', 'Project name or ID')
    .option('--color <hex>', 'Tag color (#RRGGBB)', '#6366f1')
    .option('--text-color <hex>', 'Text color (#RRGGBB)', '#ffffff')
    .action(async (name: string, opts) => {
      const db = openDb()
      const project = resolveProject(db, opts.project)

      const id = crypto.randomUUID()
      const { sort_order: nextOrder } = db.query<{ sort_order: number }>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM tags WHERE project_id = :pid`,
        { ':pid': project.id }
      )[0] ?? { sort_order: 0 }

      db.run(
        `INSERT INTO tags (id, project_id, name, color, text_color, sort_order)
         VALUES (:id, :pid, :name, :color, :textColor, :sortOrder)`,
        {
          ':id': id,
          ':pid': project.id,
          ':name': name,
          ':color': opts.color,
          ':textColor': opts.textColor,
          ':sortOrder': nextOrder,
        }
      )

      db.close()
      await notifyApp()
      console.log(`Created tag: ${id.slice(0, 8)}  ${name}  ${opts.color}`)
    })

  // slay tags delete
  cmd
    .command('delete <id>')
    .description('Delete a tag (id prefix supported)')
    .action(async (idPrefix: string) => {
      const db = openDb()

      const tags = db.query<{ id: string; name: string }>(
        `SELECT id, name FROM tags WHERE id LIKE :prefix || '%' LIMIT 2`,
        { ':prefix': idPrefix }
      )

      if (tags.length === 0) { console.error(`Tag not found: ${idPrefix}`); process.exit(1) }
      if (tags.length > 1) {
        console.error(`Ambiguous id prefix "${idPrefix}". Matches: ${tags.map((t) => t.id.slice(0, 8)).join(', ')}`)
        process.exit(1)
      }

      const tag = tags[0]
      db.run(`DELETE FROM tags WHERE id = :id`, { ':id': tag.id })
      db.close()
      await notifyApp()
      console.log(`Deleted tag: ${tag.id.slice(0, 8)}  ${tag.name}`)
    })

  return cmd
}
