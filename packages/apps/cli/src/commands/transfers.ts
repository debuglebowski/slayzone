import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import type { Command } from 'commander'
import type { TaskMove } from '@slayzone/task-contracts'
import { apiGet, apiPost } from '../api'
import { resolveId } from './tasks/_shared'

interface TransferOptions {
  project?: string
  hub?: string
  title?: string
  name?: string
  subtasks?: boolean
  sessions?: boolean
  wait?: boolean
  json?: boolean
}

async function report(data: TaskMove | unknown, opts: TransferOptions): Promise<void> {
  let move = data as TaskMove
  if (opts.wait !== false && move.id && move.status === 'running') {
    console.error(
      `Transfer ${move.id}: waiting for the connected app. Use --no-wait to return immediately.`
    )
    while (move.status === 'running') {
      await setTimeout(500)
      move = (await apiGet<{ data: TaskMove }>(`/api/task-moves/${encodeURIComponent(move.id)}`))
        .data
    }
  }
  if (opts.json) console.log(JSON.stringify(move))
  else if (move.id)
    console.log(
      `${move.id}  ${move.mode ?? 'move'}  ${move.status}  ${move.step}${move.error ? `  ${move.error}` : ''}`
    )
  else console.log(JSON.stringify(data))
  if (move.status === 'failed') process.exitCode = 1
}

export function registerTaskTransfers(cmd: Command): void {
  for (const mode of ['move', 'copy'] as const) {
    const command = cmd
      .command(`${mode} [id]`)
      .description(
        `${mode === 'copy' ? 'Copy' : 'Move'} a task to a project on this or another connected hub`
      )
      .requiredOption('--project <name|id>', 'Destination project')
      .option('--hub <hub>', 'Destination hub ID or app label (source: root --hub)')
      .option('--no-subtasks', 'Leave subtasks out')
      .option('--no-sessions', 'Start fresh agent sessions')
      .option('--no-wait', 'Return transfer ID immediately')
      .option('--json', 'Output JSON')
    if (mode === 'copy') command.option('--title <title>', 'Copied task title')
    command.action(async (id: string | undefined, opts: TransferOptions) => {
      const taskId = await resolveId(id)
      const result = await apiPost<{ data: unknown }>(
        `/api/tasks/${encodeURIComponent(taskId)}/${mode}`,
        {
          id: randomUUID(),
          project: opts.project,
          hub: opts.hub,
          title: opts.title,
          includeSubtasks: opts.subtasks !== false,
          includeSessions: mode === 'copy' ? false : opts.sessions !== false
        }
      )
      await report(result.data, opts)
    })
  }
  const moves = cmd.command('moves').description('List and control task and project transfers')
  moves
    .command('list', { isDefault: true })
    .option('--json', 'Output JSON')
    .action(async (opts: TransferOptions) => {
      const { data } = await apiGet<{ data: TaskMove[] }>('/api/task-moves')
      if (opts.json) console.log(JSON.stringify(data))
      else
        for (const move of data)
          console.log(
            `${move.id}  ${move.mode ?? 'move'}  ${move.scope}  ${move.status}  ${move.step}`
          )
    })
  for (const action of ['pause', 'resume', 'cancel']) {
    moves
      .command(`${action} <id>`)
      .description(`${action} a transfer`)
      .action(async (id: string) => {
        const { data } = await apiPost<{ data: TaskMove }>(
          `/api/task-moves/${encodeURIComponent(id)}/${action}`,
          {}
        )
        console.log(`${data.id}  ${action} requested`)
      })
  }
}

export function registerProjectTransfers(cmd: Command): void {
  for (const mode of ['move', 'copy'] as const) {
    const command = cmd
      .command(`${mode} <project>`)
      .description(`${mode === 'copy' ? 'Copy' : 'Move'} a whole project`)
      .option('--no-sessions', 'Start fresh agent sessions')
      .option('--no-wait', 'Return transfer ID immediately')
      .option('--json', 'Output JSON')
    if (mode === 'move') command.requiredOption('--hub <hub>', 'Destination hub ID or app label')
    else
      command
        .option('--hub <hub>', 'Destination hub; omitted copies within this hub')
        .option('--name <name>', 'Copied project name')
    command.action(async (project: string, opts: TransferOptions) => {
      const { data } = await apiPost<{ data: unknown }>(
        `/api/projects/${encodeURIComponent(project)}/${mode}`,
        {
          id: randomUUID(),
          hub: opts.hub,
          name: opts.name,
          includeSessions: mode === 'copy' ? false : opts.sessions !== false
        }
      )
      await report(data, opts)
    })
  }
}

/** Scope --hub as a destination only for move/copy; keep legacy root flag placement elsewhere. */
export function hasTransferDestination(args: readonly string[]): boolean {
  let index = 0
  while (index < args.length && args[index].startsWith('-')) {
    if (args[index] === '--hub') index += 2
    else index += 1
  }
  return (
    (args[index] === 'tasks' || args[index] === 'projects') &&
    (args[index + 1] === 'move' || args[index + 1] === 'copy')
  )
}
