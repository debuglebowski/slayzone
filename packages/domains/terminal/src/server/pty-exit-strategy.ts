/**
 * Pure decision logic for PTY exit handling.
 * Extracted from pty-manager to enable unit testing.
 */

export interface ExitContext {
  exitCode: number
  terminalMode: string
  hasPostSpawnCommand: boolean
  resuming: boolean
  usedShellFallback: boolean
  /** The non-zero exit was a stale `--resume` (provider auto-cleaned the
   *  session — issue #90). When true, suppress the shell fallback so the
   *  friendly "session expired" dead overlay surfaces instead of burying the
   *  "No conversation found" error in a raw recovery shell. */
  isStale: boolean
}

/** Should we spawn an interactive shell after the CLI exits? */
export function shouldShellFallback(ctx: ExitContext): boolean {
  return ctx.hasPostSpawnCommand && ctx.exitCode !== 0 && !ctx.usedShellFallback && !ctx.isStale
}

/** Build the recovery message shown in the terminal buffer. */
export function buildRecoveryMessage(terminalMode: string, exitCode: number): string {
  return `\r\n[SlayZone] ${terminalMode} exited with code ${String(exitCode)}. Switched to interactive shell for recovery.\r\n`
}
