import { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import { PROVIDER_PATHS } from '@slayzone/ai-config/shared'
import type { CliProvider } from '@slayzone/ai-config/shared'
import { apiGet, apiPost } from '../api'
import { notifyApp } from '../db'

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

interface SyncedSkill {
  slug: string
  name: string
  content: string
  action: 'installed' | 'updated'
}

interface InstallSkillsResponse {
  project: { id: string; name: string; path: string | null }
  providers: CliProvider[]
  stats: SkillStats
  skills: SyncedSkill[]
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

/**
 * Mirror the skills the hub just wrote into each provider's on-disk skills dir.
 *
 * Only meaningful on the machine that owns the project checkout, so it is gated
 * on `projectPath` existing HERE — a CLI talking to a hub elsewhere has no
 * checkout to write into, and the skills are read from the hub's database anyway.
 * The gate is the natural one: it was already conditional on `projectPath`.
 */
function writeSkillsToDisk(
  projectPath: string,
  providers: CliProvider[],
  skills: SyncedSkill[]
): void {
  for (const provider of providers) {
    const mapping = PROVIDER_PATHS[provider]
    if (!mapping?.skillsDir) continue
    for (const skill of skills) {
      const filePath = path.join(projectPath, mapping.skillsDir, skill.slug, 'SKILL.md')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, skill.content, 'utf-8')
    }
  }
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

/**
 * The project this invocation targets: `--project <name|id>` resolved by the hub
 * (`resolveProjectRef`), else inferred from $PWD by the hub
 * (`resolveProjectByPath`). Both replace direct reads of the `projects` table.
 *
 * The cwd path is sent to the hub deliberately even though the hub may be another
 * machine: `projects.path` is what the operator configured, and inference only
 * succeeds when it happens to match — which is exactly the local case. A remote
 * hub simply 404s, with the same "No project found for directory" wording, so
 * `--project` is the answer there just as it always was for a pathless project.
 */
async function resolveTargetProjectRef(explicit?: string): Promise<string> {
  if (explicit) return explicit
  const { data } = await apiGet<{ ok: true; data: { id: string; name: string; path: string } }>(
    `/api/projects/resolve-by-path?path=${encodeURIComponent(process.cwd())}`
  )
  return data.id
}

/**
 * `slay init` / `slay init skills`.
 *
 * Split by ownership:
 *  - HUB STATE (project resolution, provider set, the `ai_config_items` skill rows
 *    and their `installedVersion` content-hash comparison) → POST
 *    /api/projects/:id/skills. All of it used to run here against the hub's SQLite
 *    file, which made `slay init` local-only. The hash comparison moved WITH the
 *    write on purpose — left here it would be hashing against rows a remote CLI
 *    can no longer read.
 *  - LOCAL FILES (root instructions + `<skillsDir>/<slug>/SKILL.md`) stay here,
 *    gated on the project's configured path existing on THIS machine. Against a
 *    remote hub those branches simply don't fire; the skill records are still
 *    installed, and they are what the hub reads from anyway.
 */
async function runInstall(opts: { writeInstructions: boolean; project?: string }): Promise<void> {
  const projectRef = await resolveTargetProjectRef(opts.project)

  const { data } = await apiPost<{ ok: true; data: InstallSkillsResponse }>(
    `/api/projects/${encodeURIComponent(projectRef)}/skills`,
    {}
  )
  const { project, providers, stats, skills } = data

  // A path only means something if it exists HERE. A hub on another machine
  // reports ITS project path, which is not a directory on this box.
  const localPath = project.path && fs.existsSync(project.path) ? project.path : null

  if (opts.writeInstructions && localPath) {
    const written = writeInstructionsToDisk(localPath, providers)
    for (const f of written) console.log(`  Appended instructions to ${f}`)
  }

  // Per-skill lines are the CLI's own output; the hub supplies which skills
  // changed and how (`action`), since installs and updates interleave in registry
  // order and the counts alone can't attribute a line to a skill.
  for (const skill of skills) {
    console.log(`  ${skill.action === 'installed' ? 'Installed' : 'Updated'} ${skill.name}`)
  }

  if (localPath && skills.length > 0) writeSkillsToDisk(localPath, providers, skills)

  if (stats.installed + stats.updated > 0) await notifyApp()
  logSkillStats(stats, project.name)
}

/**
 * `--project` as commander actually delivers it.
 *
 * `init` and `init skills` BOTH declare `-p, --project` (so it shows in each
 * one's `--help`). Commander parses the parent's options first, so in
 * `slay init skills --project X` the PARENT consumes the flag and the
 * subcommand's own `opts()` comes back empty — `slay init skills --project X`
 * silently ignored the project and fell back to cwd inference. `optsWithGlobals()`
 * merges the ancestor values in, so the flag resolves wherever it was captured.
 */
function projectOpt(command: Command): string | undefined {
  return command.optsWithGlobals<{ project?: string }>().project
}

export function initCommand(): Command {
  const cmd = new Command('init')
    .description('Bootstrap SlayZone agent config (instructions + skills) for the current project')
    .option('-p, --project <name|id>', 'Project name or ID (defaults to project resolved from cwd)')
    .showSuggestionAfterError(true)
    .showHelpAfterError(true)
    .action((_opts, command: Command) =>
      runInstall({ writeInstructions: true, project: projectOpt(command) })
    )

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
    .action((_opts, command: Command) =>
      runInstall({ writeInstructions: false, project: projectOpt(command) })
    )

  return cmd
}
