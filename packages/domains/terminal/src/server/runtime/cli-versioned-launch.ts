/**
 * Launch args that depend on the agent CLI's version ON THE COMPUTER IT STARTS ON
 * (`TerminalAdapter.cliVersioned`) — today codex `--no-daemon`.
 *
 * Agents never run hub-local, and a hub serves computers with different installs,
 * so the hub asks the computer (`PtyBackend.cliVersion`) rather than probing its
 * own PATH. Anything short of a version — no computer, an older computer, a lost
 * link, a slow answer, a CLI that prints none — launches exactly as before: an
 * older CLI rejects a flag it doesn't know and exits, which is worse than going
 * without it.
 *
 * @module terminal/server/runtime/cli-versioned-launch
 */
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import type { TerminalAdapter } from '../adapters/types'
import type { PtyBackend } from './pty-backend'

/** Upper bound on one spawn's wait for the answer (the computer caches it after). */
export const CLI_VERSION_WAIT_MS = 10_000

/** `/usr/local/bin/codex`, `codex.cmd`, `C:\…\codex.exe` → `codex`. */
function commandName(binary: string): string {
  const base = binary.split(/[\\/]/).pop() ?? binary
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
}

export async function cliVersionedLaunchArgs(input: {
  adapter: Pick<TerminalAdapter, 'cliVersioned'>
  backend: Pick<PtyBackend, 'cliVersion'>
  computerId: string | null
  /** The binary the launch command runs, and the args it already has. */
  binary: string
  args: readonly string[]
  sessionId: string
  taskId: string | null
}): Promise<string[]> {
  const spec = input.adapter.cliVersioned
  // Only when the command really runs that CLI: a custom wrapper's own version
  // says nothing about the flags the CLI underneath accepts.
  if (!spec || commandName(input.binary) !== spec.binary) return []
  if (input.computerId === null || !input.backend.cliVersion) return []
  let version: string | null = null
  let error: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    version = await Promise.race([
      input.backend.cliVersion(input.computerId, spec.binary),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          error = `no answer within ${CLI_VERSION_WAIT_MS}ms`
          resolve(null)
        }, CLI_VERSION_WAIT_MS)
      })
    ])
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timer)
  }
  const args = version ? spec.launchArgs(version).filter((a) => !input.args.includes(a)) : []
  recordDiagnosticEvent({
    level: error ? 'warn' : 'info',
    source: 'pty',
    event: 'pty.cli_version',
    sessionId: input.sessionId,
    taskId: input.taskId ?? undefined,
    payload: { binary: spec.binary, version, launchArgs: args, error }
  })
  return args
}
