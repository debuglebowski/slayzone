import { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import { apiGet, apiPost, apiPatch } from '../api'
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

/** Narrow a full Project row to the CLI's stable `--json` field set. */
function narrowProject(p: Record<string, unknown>): CreatedProjectRow {
  return {
    id: p.id as string,
    name: p.name as string,
    color: p.color as string,
    path: (p.path as string | null) ?? null,
    created_at: p.created_at as string,
    updated_at: p.updated_at as string
  }
}

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
  const cmd = new Command('projects')
    .description('Manage projects')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)

  // slay projects list
  cmd
    .command('list')
    .description('List all projects')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      // GET /api/projects returns id, name, path + live (non-archived/deleted/
      // temporary) task_count, ordered by name.
      const { data: projects } = await apiGet<{ ok: true; data: ProjectRow[] }>('/api/projects')

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
    .option(
      '--path <path>',
      'Repository path (relative paths are resolved from current directory and auto-created)'
    )
    .option('--color <hex>', 'Project color (#RRGGBB)', DEFAULT_PROJECT_COLOR)
    .option('--json', 'Output created project as JSON')
    .action(async (name: string, opts: { path?: string; color: string; json?: boolean }) => {
      const projectPath = normalizeProjectPath(opts.path)
      // Validate name + color locally FIRST (same messages), so an invalid
      // input never creates the directory (parity with the original ordering).
      let prepared: ReturnType<typeof prepareProjectCreate>
      try {
        prepared = prepareProjectCreate({ name, color: opts.color, path: projectPath })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(message)
        process.exit(1)
      }

      const createdPath = ensureProjectPath(prepared.path)
      if (createdPath && prepared.path) {
        console.error(`Created directory: ${prepared.path}`)
      }

      // POST /api/projects persists the metadata (server allocates id +
      // sort_order via the shared create op).
      const { data } = await apiPost<{ ok: true; data: CreatedProjectRow }>('/api/projects', {
        name: prepared.name,
        color: prepared.color,
        path: prepared.path
      })
      const project = narrowProject(data)

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
    .action(
      async (
        proj: string,
        opts: { name?: string; color?: string; path?: string; json?: boolean }
      ) => {
        if (opts.name === undefined && opts.color === undefined && opts.path === undefined) {
          console.error('Provide at least one of --name, --color, --path')
          process.exit(1)
        }

        const body: Record<string, unknown> = {}
        if (opts.name !== undefined) body.name = opts.name
        if (opts.color !== undefined) body.color = opts.color
        if (opts.path !== undefined) {
          const resolved = normalizeProjectPath(opts.path)
          if (resolved) ensureProjectPath(resolved)
          body.path = resolved
        }

        // PATCH /api/projects/:id resolves the project (id or name substring)
        // and persists via the shared update op.
        const { data } = await apiPatch<{ ok: true; data: CreatedProjectRow }>(
          `/api/projects/${encodeURIComponent(proj)}`,
          body
        )
        const updated = narrowProject(data)

        if (opts.json) {
          console.log(JSON.stringify(updated, null, 2))
          return
        }
        console.log(`Updated project: ${updated.id.slice(0, 8)}  ${updated.name}`)
      }
    )

  return cmd
}
