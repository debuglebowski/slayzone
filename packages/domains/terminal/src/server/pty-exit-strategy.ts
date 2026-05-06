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
}

/** Should we spawn an interactive shell after the CLI exits? */
export function shouldShellFallback(ctx: ExitContext): boolean {
  return ctx.hasPostSpawnCommand && ctx.exitCode !== 0 && !ctx.usedShellFallback
}

/** Should we notify the renderer that the resumed session was not found? */
export function shouldNotifySessionNotFound(ctx: ExitContext): boolean {
  return ctx.resuming && ctx.exitCode !== 0
}

/** Build the recovery message shown in the terminal buffer. */
export function buildRecoveryMessage(terminalMode: string, exitCode: number): string {
  return `\r\n[SlayZone] ${terminalMode} exited with code ${String(exitCode)}. Switched to interactive shell for recovery.\r\n`
}
