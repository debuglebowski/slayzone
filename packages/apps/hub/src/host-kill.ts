import type { SlayzoneDb } from '@slayzone/platform'
import { setOnHostKillHandler } from '@slayzone/terminal/server'
import { setProviderLastKilledAt } from '@slayzone/task/shared'
import type { ProviderConfig } from '@slayzone/task/shared'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'

/**
 * Persist the host-kill timestamp into `provider_config` so the revive flow can
 * choose between resuming a hot session and starting a fresh conversation
 * (COLD_RESPAWN_MS).
 *
 * Lives in the side-car because `onHostKillHandler` fires in whichever process
 * owns the pty sessions, and since slice 9 that is this one. The Electron host
 * registered it against its OWN `pty-manager` module singleton, which owns no
 * sessions in local mode — so the stamp was simply never written. The handler was
 * only ever on the host because the `db` handle was.
 *
 * `setter` is injectable purely so a test can capture the handler instead of
 * driving the real module global.
 */
export function wireHostKillStamp(
  db: SlayzoneDb,
  setter: (fn: (taskId: string) => void) => void = setOnHostKillHandler
): void {
  setter(async (taskId: string) => {
    try {
      const row = (await db
        .prepare('SELECT provider_config, terminal_mode FROM tasks WHERE id = ?')
        .get(taskId)) as { provider_config: string | null; terminal_mode: string | null } | undefined
      // No mode means no provider to stamp against — a task that never ran an agent.
      if (!row?.terminal_mode) return
      const cfg: ProviderConfig = row.provider_config ? JSON.parse(row.provider_config) : {}
      const next = setProviderLastKilledAt(cfg, row.terminal_mode, Date.now())
      await db
        .prepare('UPDATE tasks SET provider_config = ? WHERE id = ?')
        .run(JSON.stringify(next), taskId)
    } catch (err) {
      recordDiagnosticEvent({
        level: 'warn',
        source: 'pty',
        event: 'pty.host_kill_persist_failed',
        taskId,
        message: (err as Error).message
      })
    }
  })
}
