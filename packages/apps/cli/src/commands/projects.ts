import { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import { apiFetch, apiGet, apiPost, apiPatch } from '../api'
import { isCoLocatedHub } from '../local-hub'
import { prepareProjectCreate } from '@slayzone/projects-contracts'

interface ProjectRow extends Record<string, unknown> {
  id: string
  name: string
  path: string
  /** The computer the hub uses for the project. Absent on an older hub. */
  computer_id?: string | null
  task_count: number
}

interface CreatedProjectRow extends Record<string, unknown> {
  id: string
  name: string
  color: string
  path: string | null
  computer_id: string | null
  created_at: string
  updated_at: string
}

/** A computer as `GET /api/computers` lists it. */
interface HubComputer {
  id: string
  name: string
  usable: boolean
}

/** One project folder as the hub records it (`placements` on a returned project). */
interface Placement {
  computer_id: string
  path: string
  status: string
}

const DEFAULT_PROJECT_COLOR = '#3b82f6'

/** Narrow a full Project row to the CLI's stable `--json` field set. */
function narrowProject(p: Record<string, unknown>): CreatedProjectRow {
  return {
    id: p.id as string,
    name: p.name as string,
    color: p.color as string,
    path: (p.path as string | null) ?? null,
    computer_id: (p.resolved_computer_id as string | null | undefined) ?? null,
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

/**
 * A computer of the hub by id, name (case-insensitive) or id prefix. Exits with the
 * hub's computers listed when nothing, or more than one, matches.
 */
async function resolveHubComputer(ref: string): Promise<HubComputer> {
  const computers = await apiGet<HubComputer[]>('/api/computers')
  const wanted = ref.trim().toLowerCase()
  const exact = computers.find((c) => c.id === ref.trim())
  const byName = computers.filter((c) => c.name.toLowerCase() === wanted)
  const byPrefix = computers.filter((c) => c.id.toLowerCase().startsWith(wanted))
  const matches = exact ? [exact] : byName.length > 0 ? byName : byPrefix
  if (matches.length === 1) return matches[0]!
  const available =
    computers.length > 0
      ? ` Available: ${computers.map((c) => `${c.name} (${c.id.slice(0, 8)})`).join(', ')}`
      : ' This hub has no computers.'
  console.error(
    matches.length === 0
      ? `No computer matching "${ref}".${available}`
      : `Ambiguous computer "${ref}".${available}`
  )
  process.exit(1)
}

/** Absolute on any OS: a computer may run a different one than this machine. */
function isAbsoluteAnywhere(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p)
}

/**
 * Where `--path` lives, and so who may touch it.
 *
 * Local: the folder is on this machine (the hub runs here and no other computer was
 * named) — resolve it against the cwd and create it, as `slay` always has. Remote:
 * it is on another computer's disk, which this machine cannot see, so the path must
 * be absolute and goes to the hub untouched; the computer checks it.
 */
async function prepareFolder(
  input: string | undefined,
  computer: HubComputer | null
): Promise<{ path: string | null; local: boolean }> {
  const local = computer === null && (await isCoLocatedHub())
  const trimmed = input?.trim() || null
  if (!trimmed) return { path: null, local }
  if (local) return { path: normalizeProjectPath(trimmed), local }
  if (!isAbsoluteAnywhere(trimmed)) {
    const where = computer ? `computer "${computer.name}"` : 'the hub’s computer'
    console.error(
      `--path must be absolute: it is a folder on ${where}, not on this machine, so it cannot be resolved from here.`
    )
    process.exit(1)
  }
  return { path: trimmed, local }
}

/** Say so when the computer does not have the folder yet: the project exists, agents won't start. */
function warnUnreadyFolder(
  project: Record<string, unknown>,
  computer: HubComputer | null,
  folder: string | null
): void {
  if (!folder) return
  const computerId = computer?.id ?? (project.resolved_computer_id as string | null | undefined)
  const placement = ((project.placements as Placement[] | undefined) ?? []).find(
    (pl) => pl.computer_id === computerId
  )
  const name = computer ? `"${computer.name}"` : 'the project’s computer'
  if (placement?.status === 'missing') {
    console.error(
      `Folder not found on ${name}: ${folder}. Create it there; agents start once it exists.`
    )
  } else if (placement?.status === 'pending') {
    console.error(`${name} is offline. The folder is recorded when it connects: ${folder}`)
  }
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
      // GET /api/projects returns id, name, path, computer_id + live (non-archived/
      // deleted/temporary) task_count, ordered by name.
      const { data: projects } = await apiGet<{ ok: true; data: ProjectRow[] }>('/api/projects')

      if (opts.json) {
        console.log(JSON.stringify(projects, null, 2))
        return
      }

      if (projects.length === 0) {
        console.log('No projects found.')
        return
      }

      // Computer names for the table. Best-effort: without them the column shows
      // id prefixes, and a listing must not fail over a column.
      const computerNames = new Map<string, string>()
      const computersRes = await apiFetch('/api/computers').catch(() => null)
      if (computersRes?.ok) {
        const computers = (await computersRes.json().catch(() => [])) as HubComputer[]
        for (const c of computers) computerNames.set(c.id, c.name)
      }

      const idW = 9
      const nameW = 24
      const computerW = 16
      console.log(
        `${'ID'.padEnd(idW)}  ${'NAME'.padEnd(nameW)}  TASKS  ${'COMPUTER'.padEnd(computerW)}  PATH`
      )
      console.log(
        `${'-'.repeat(idW)}  ${'-'.repeat(nameW)}  -----  ${'-'.repeat(computerW)}  ${'-'.repeat(30)}`
      )
      for (const p of projects) {
        const id = String(p.id).slice(0, 8).padEnd(idW)
        const name = String(p.name).slice(0, nameW).padEnd(nameW)
        const tasks = String(p.task_count).padStart(5)
        const computer = (
          p.computer_id ? (computerNames.get(p.computer_id) ?? p.computer_id.slice(0, 8)) : '-'
        )
          .slice(0, computerW)
          .padEnd(computerW)
        console.log(`${id}  ${name}  ${tasks}  ${computer}  ${p.path ?? ''}`)
      }
    })

  // slay projects create
  cmd
    .command('create <name>')
    .description('Create a new project')
    .option(
      '--path <path>',
      'Repository path (relative paths are resolved from current directory and auto-created). ' +
        'With --computer, or a hub on another machine: an absolute path on that computer, used as is'
    )
    .option(
      '--computer <name|id>',
      'Computer the project runs on (its agents, and the --path folder). Default: the hub picks'
    )
    .option('--color <hex>', 'Project color (#RRGGBB)', DEFAULT_PROJECT_COLOR)
    .option('--json', 'Output created project as JSON')
    .action(
      async (
        name: string,
        opts: { path?: string; computer?: string; color: string; json?: boolean }
      ) => {
        const computer = opts.computer ? await resolveHubComputer(opts.computer) : null
        const folder = await prepareFolder(opts.path, computer)
        // Validate name + color locally FIRST (same messages), so an invalid
        // input never creates the directory (parity with the original ordering).
        let prepared: ReturnType<typeof prepareProjectCreate>
        try {
          prepared = prepareProjectCreate({ name, color: opts.color, path: folder.path })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(message)
          process.exit(1)
        }

        if (folder.local) {
          const createdPath = ensureProjectPath(prepared.path)
          if (createdPath && prepared.path) {
            console.error(`Created directory: ${prepared.path}`)
          }
        }

        // POST /api/projects persists the metadata (server allocates id +
        // sort_order via the shared create op) and records the folder on the
        // project's computer.
        const { data } = await apiPost<{ ok: true; data: CreatedProjectRow }>('/api/projects', {
          name: prepared.name,
          color: prepared.color,
          path: prepared.path,
          ...(computer ? { computerId: computer.id } : {})
        })
        if (!folder.local) warnUnreadyFolder(data, computer, prepared.path)
        const project = narrowProject(data)

        if (opts.json) {
          console.log(JSON.stringify(project, null, 2))
          return
        }

        const location = project.path ? `  ${project.path}` : ''
        const on = computer ? `  (on ${computer.name})` : ''
        console.log(`Created project: ${project.id.slice(0, 8)}  ${project.name}${location}${on}`)
      }
    )

  // slay projects update
  cmd
    .command('update <name|id>')
    .description('Update a project')
    .option('--name <name>', 'New project name')
    .option('--color <hex>', 'New project color (#RRGGBB)')
    .option(
      '--path <path>',
      'New repository path. With --computer, or a hub on another machine: an absolute path on that computer'
    )
    .option(
      '--computer <name|id>',
      'Move the project to this computer (its agents run there); --path is its folder there'
    )
    .option('--json', 'Output updated project as JSON')
    .action(
      async (
        proj: string,
        opts: { name?: string; color?: string; path?: string; computer?: string; json?: boolean }
      ) => {
        if (
          opts.name === undefined &&
          opts.color === undefined &&
          opts.path === undefined &&
          opts.computer === undefined
        ) {
          console.error('Provide at least one of --name, --color, --path, --computer')
          process.exit(1)
        }

        const computer = opts.computer ? await resolveHubComputer(opts.computer) : null
        const body: Record<string, unknown> = {}
        if (opts.name !== undefined) body.name = opts.name
        if (opts.color !== undefined) body.color = opts.color
        if (computer) body.computerId = computer.id
        let folder: { path: string | null; local: boolean } | null = null
        if (opts.path !== undefined) {
          folder = await prepareFolder(opts.path, computer)
          if (folder.local && folder.path) ensureProjectPath(folder.path)
          body.path = folder.path
        }

        // PATCH /api/projects/:id resolves the project (id or name substring)
        // and persists via the shared update op.
        const { data } = await apiPatch<{ ok: true; data: CreatedProjectRow }>(
          `/api/projects/${encodeURIComponent(proj)}`,
          body
        )
        if (folder && !folder.local) warnUnreadyFolder(data, computer, folder.path)
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
