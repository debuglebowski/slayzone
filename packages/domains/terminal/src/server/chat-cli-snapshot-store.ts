import type { SlayzoneDb } from '@slayzone/platform'
import type { CliCommandList } from '@slayzone/terminal-contracts'

/**
 * Last slash-command list a chat CLI advertised, per project + chat mode
 * (`chat_cli_snapshots`, migration v172). Lets the composer's `/` menu list the
 * CLI's commands before a session's first turn.
 */

/** Upsert the list for the project of `taskId`. No-op when the task is unknown. */
export async function saveChatCliSnapshot(
  db: SlayzoneDb,
  taskId: string,
  mode: string,
  list: CliCommandList,
  now: number = Date.now()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chat_cli_snapshots
         (project_id, mode, slash_commands, terminal_slash_commands, skills, cli_version, observed_at)
       SELECT project_id, ?, ?, ?, ?, ?, ? FROM tasks WHERE id = ? AND project_id IS NOT NULL
       ON CONFLICT (project_id, mode) DO UPDATE SET
         slash_commands = excluded.slash_commands,
         terminal_slash_commands = excluded.terminal_slash_commands,
         skills = excluded.skills,
         cli_version = excluded.cli_version,
         observed_at = excluded.observed_at`
    )
    .run(
      mode,
      JSON.stringify(list.slashCommands),
      JSON.stringify(list.terminalSlashCommands),
      JSON.stringify(list.skills),
      list.cliVersion,
      now,
      taskId
    )
}

/** The list stored for the project of `taskId`, or null (none yet / corrupt row). */
export async function getChatCliSnapshot(
  db: SlayzoneDb,
  taskId: string,
  mode: string
): Promise<CliCommandList | null> {
  const row = (await db
    .prepare(
      `SELECT s.slash_commands, s.terminal_slash_commands, s.skills, s.cli_version
         FROM chat_cli_snapshots s
         JOIN tasks t ON t.project_id = s.project_id
        WHERE t.id = ? AND s.mode = ?`
    )
    .get(taskId, mode)) as
    | {
        slash_commands: string
        terminal_slash_commands: string
        skills: string
        cli_version: string | null
      }
    | undefined
  if (!row) return null
  const slashCommands = parseStringList(row.slash_commands)
  const terminalSlashCommands = parseStringList(row.terminal_slash_commands)
  const skills = parseStringList(row.skills)
  if (!slashCommands || !terminalSlashCommands || !skills) return null
  return { slashCommands, terminalSlashCommands, skills, cliVersion: row.cli_version }
}

function parseStringList(json: string): string[] | null {
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null
  } catch {
    return null
  }
}
