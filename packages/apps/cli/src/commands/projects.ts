import { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import { openDb, notifyApp, resolveProject } from '../db'
import { prepareProjectCreate } from '@slayzone/projects/shared'

interface ProjectRow extends Record<string, unknown> {
  id: string
  name: string
  path: string
  task_count: number
}

interface CreatedProjectRow extends Record<string, unknown> {
  id: string
  name: string
  color: string
  path: string | null
  created_at: string
  updated_at: string
}

const DEFAULT_PROJECT_COLOR = '#3b82f6'

function normalizeProjectPath(input: string | undefined): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  return path.resolve(trimmed)
}

function ensureProjectPath(projectPath: string | null): boolean {
  if (!projectPath) return false
  const existedBefore = fs.existsSync(projectPath)

  try {
    fs.mkdirSync(projectPath, { recursive: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Failed to create project path "${projectPath}": ${message}`)
    process.exit(1)
  }

  try {
    const stat = fs.statSync(projectPath)
    if (!stat.isDirectory()) {
      console.error(`Project path exists but is not a directory: ${projectPath}`)
      process.exit(1)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Failed to verify project path "${projectPath}": ${message}`)
    process.exit(1)
  }

  return !existedBefore
}

export function projectsCommand(): Command {
  const cmd = new Command('projects').description('Manage projects')

  // slay projects list
  cmd
    .command('list')
    .description('List all projects')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const db = openDb()

      const projects = db.query<ProjectRow>(
        `SELECT p.id, p.name, p.path,
           COUNT(t.id) FILTER (WHERE t.archived_at IS NULL AND t.is_temporary = 0) AS task_count
         FROM projects p
         LEFT JOIN tasks t ON t.project_id = p.id
         GROUP BY p.id
         ORDER BY p.name ASC`
      )

      if (opts.json) {
        console.log(JSON.stringify(projects, null, 2))
        return
      }

      if (projects.length === 0) {
        console.log('No projects found.')
        return
      }

      const idW = 9
      const nameW = 24
      console.log(`${'ID'.padEnd(idW)}  ${'NAME'.padEnd(nameW)}  TASKS  PATH`)
      console.log(`${'-'.repeat(idW)}  ${'-'.repeat(nameW)}  -----  ${'-'.repeat(30)}`)
      for (const p of projects) {
        const id = String(p.id).slice(0, 8).padEnd(idW)
        const name = String(p.name).slice(0, nameW).padEnd(nameW)
        const tasks = String(p.task_count).padStart(5)
        console.log(`${id}  ${name}  ${tasks}  ${p.path}`)
      }
    })

  // slay projects create
  cmd
    .command('create <name>')
    .description('Create a new project')
    .option('--path <path>', 'Repository path (relative paths are resolved from current directory and auto-created)')
    .option('--color <hex>', 'Project color (#RRGGBB)', DEFAULT_PROJECT_COLOR)
    .option('--json', 'Output created project as JSON')
    .action(async (name: string, opts: { path?: string; color: string; json?: boolean }) => {
      const projectPath = normalizeProjectPath(opts.path)
      let prepared: ReturnType<typeof prepareProjectCreate>
      try {
        prepared = prepareProjectCreate({
          name,
          color: opts.color,
          path: projectPath,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(message)
        process.exit(1)
      }

      const createdPath = ensureProjectPath(prepared.path)
      if (createdPath && prepared.path) {
        console.error(`Created directory: ${prepared.path}`)
      }

      const db = openDb()
      let project: CreatedProjectRow | undefined
      try {
        db.run('BEGIN')
        try {
          const { sort_order: nextOrder } = db.query<{ sort_order: number }>(
            'SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM projects'
          )[0] ?? { sort_order: 0 }

          db.run(
            `INSERT INTO projects (id, name, color, path, columns_config, sort_order, created_at, updated_at)
             VALUES (:id, :name, :color, :path, :columnsConfig, :sortOrder, :createdAt, :updatedAt)`,
            {
              ':id': prepared.id,
              ':name': prepared.name,
              ':color': prepared.color,
              ':path': prepared.path,
              ':columnsConfig': prepared.columnsConfigJson,
              ':sortOrder': nextOrder,
              ':createdAt': prepared.createdAt,
              ':updatedAt': prepared.updatedAt,
            }
          )
          db.run('COMMIT')
        } catch (e) {
          db.run('ROLLBACK')
          throw e
        }

        project = db.query<CreatedProjectRow>(
          `SELECT id, name, color, path, created_at, updated_at
           FROM projects
           WHERE id = :id
           LIMIT 1`,
          { ':id': prepared.id }
        )[0]
      } finally {
        db.close()
      }

      if (!project) {
        console.error('Failed to create project.')
        process.exit(1)
      }

      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify(project, null, 2))
        return
      }

      const location = project.path ? `  ${project.path}` : ''
      console.log(`Created project: ${project.id.slice(0, 8)}  ${project.name}${location}`)
    })

  // slay projects update
  cmd
    .command('update <name|id>')
    .description('Update a project')
    .option('--name <name>', 'New project name')
    .option('--color <hex>', 'New project color (#RRGGBB)')
    .option('--path <path>', 'New repository path')
    .option('--json', 'Output updated project as JSON')
    .action(async (proj: string, opts: { name?: string; color?: string; path?: string; json?: boolean }) => {
      if (opts.name === undefined && opts.color === undefined && opts.path === undefined) {
        console.error('Provide at least one of --name, --color, --path')
        process.exit(1)
      }

      const db = openDb()
      const project = resolveProject(db, proj)
      const sets: string[] = ['updated_at = :now']
      const params: Record<string, string | number | null> = { ':now': new Date().toISOString(), ':id': project.id }

      if (opts.name !== undefined) { sets.push('name = :name'); params[':name'] = opts.name }
      if (opts.color !== undefined) { sets.push('color = :color'); params[':color'] = opts.color }
      if (opts.path !== undefined) {
        const resolved = normalizeProjectPath(opts.path)
        if (resolved) ensureProjectPath(resolved)
        sets.push('path = :path')
        params[':path'] = resolved
      }

      db.run(`UPDATE projects SET ${sets.join(', ')} WHERE id = :id`, params)

      const updated = db.query<CreatedProjectRow>(
        `SELECT id, name, color, path, created_at, updated_at FROM projects WHERE id = :id LIMIT 1`,
        { ':id': project.id }
      )[0]
      db.close()
      await notifyApp()

      if (opts.json) {
        console.log(JSON.stringify(updated, null, 2))
        return
      }
      console.log(`Updated project: ${project.id.slice(0, 8)}  ${opts.name ?? project.name}`)
    })

  return cmd
}
