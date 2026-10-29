/**
 * Doctor's "can this task's computer start terminals at all?" rows.
 *
 * The adapters' `validate()` checks the agent binary and shell where the HUB runs.
 * The pty itself starts on the task's computer, and its node-pty install can be
 * unusable on its own — an install that skipped its scripts leaves spawn-helper
 * non-executable, and every agent then fails with "The computer couldn't start
 * the agent.". So the computer is asked directly (`PtyBackend.runtimeProblems`).
 *
 * @module terminal/server/runtime/runtime-doctor
 */

import type { ValidationResult } from '@slayzone/terminal-contracts'
import type { PtyBackend } from './pty-backend'

export async function computerRuntimeResults(
  computerId: string | null,
  backend: Pick<PtyBackend, 'runtimeProblems'>
): Promise<ValidationResult[]> {
  // No computer for the task, or a backend that can't ask one: nothing to report.
  if (computerId === null || !backend.runtimeProblems) return []
  let problems: Awaited<ReturnType<NonNullable<PtyBackend['runtimeProblems']>>>
  try {
    problems = await backend.runtimeProblems(computerId)
  } catch (err) {
    return [
      {
        check: 'Terminal runtime',
        ok: false,
        detail: `Couldn't ask the computer: ${err instanceof Error ? err.message : String(err)}`
      }
    ]
  }
  if (problems === null) return [] // A computer that predates the check.
  if (problems.length === 0) {
    return [{ check: 'Terminal runtime', ok: true, detail: 'This computer can start terminals.' }]
  }
  return problems.map((p) => ({ check: p.check, ok: false, detail: p.detail, fix: p.fix }))
}
