import { Command } from 'commander'
import { resolveProjectArg } from '../db'
import { apiGet, apiPost, apiDelete } from '../api'

interface TagRow extends Record<string, unknown> {
  id: string
  name: string
  color: string
  text_color: string
  sort_order: number
  created_at: string
}

export function tagsCommand(): Command {
  const cmd = new Command('tags')
    .description('Manage tags')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // slay tags list
  cmd
    .command('list')
    .description('List tags for a project')
    .option('--project <name|id>', 'Project name or ID (defaults to $SLAYZONE_PROJECT_ID)')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      // The route resolves the project (id or name substring) and orders by
      // sort_order, name — returning full tag rows.
      const project = resolveProjectArg(opts.project)
      const { data: tags } = await apiGet<{ ok: true; data: TagRow[] }>(
        `/api/tags?project=${encodeURIComponent(project)}`
      )

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
    .option('--project <name|id>', 'Project name or ID (defaults to $SLAYZONE_PROJECT_ID)')
    .option('--color <hex>', 'Tag color (#RRGGBB)', '#6366f1')
    .option('--text-color <hex>', 'Text color (#RRGGBB)', '#ffffff')
    .action(async (name: string, opts) => {
      const project = resolveProjectArg(opts.project)
      // POST /api/tags resolves the project and allocates the next sort_order.
      const { data: tag } = await apiPost<{ ok: true; data: TagRow }>('/api/tags', {
        project,
        name,
        color: opts.color,
        textColor: opts.textColor
      })
      console.log(`Created tag: ${tag.id.slice(0, 8)}  ${name}  ${tag.color}`)
    })

  // slay tags delete
  cmd
    .command('delete <id>')
    .description('Delete a tag (id prefix supported)')
    .action(async (idPrefix: string) => {
      // DELETE /api/tags/:id resolves the id prefix (404/400 parity) and returns
      // the deleted tag's id + name.
      const { data: tag } = await apiDelete<{ ok: true; data: { id: string; name: string } }>(
        `/api/tags/${encodeURIComponent(idPrefix)}`
      )
      console.log(`Deleted tag: ${tag.id.slice(0, 8)}  ${tag.name}`)
    })

  return cmd
}
