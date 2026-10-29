/**
 * Doctor's rows for a task's agent.
 *
 * The agent starts on the task's COMPUTER, so that is where its binary must be on
 * PATH, where the shell the hub asks for must exist, and whose node-pty must be
 * able to start ptys at all — an install that skipped its scripts leaves
 * spawn-helper non-executable and every agent fails with "The computer couldn't
 * start the agent.". So the computer answers for itself (`PtyBackend.doctor`).
 *
 * Without a computer to ask — none resolved for the task, or one that predates
 * `pty.doctor` — the hub checks its own PATH, as Doctor always did.
 *
 * @module terminal/server/runtime/runtime-doctor
 */

import type { ValidationResult } from '@slayzone/terminal-contracts'
import type { DoctorBinaryRequirement } from '../adapters/types'
import type { ComputerDoctorFacts, PtyBackend } from './pty-backend'

export interface DoctorInputs {
  /** What the agent needs (`TerminalAdapter.doctorRequirements`). */
  requirements: readonly DoctorBinaryRequirement[]
  /** The computer the task's agent starts on; null when none resolves. */
  computerId: string | null
  backend: Pick<PtyBackend, 'doctor'>
  /** The shell the hub will ask the computer to spawn. */
  shell: string
  /** A shell override the hub skips because it does not exist; null when none. */
  missingShellOverride: string | null
  /** The hub's own lookups, for when no computer can answer. */
  hubLocal: {
    shellExists(shell: string): boolean
    which(binary: string): Promise<string | null>
  }
}

type Facts = Omit<ComputerDoctorFacts, 'problems'> & {
  /** null: unknown — the hub runs no ptys, so it can't speak for node-pty. */
  problems: ComputerDoctorFacts['problems'] | null
  where: 'computer' | 'hub'
}

export async function runDoctor(inputs: DoctorInputs): Promise<ValidationResult[]> {
  const binaries = inputs.requirements.map((r) => r.binary)
  let facts: Facts | null = null
  if (inputs.computerId !== null && inputs.backend.doctor) {
    try {
      const answered = await inputs.backend.doctor(inputs.computerId, {
        shell: inputs.shell,
        binaries
      })
      if (answered) facts = { ...answered, where: 'computer' }
    } catch (err) {
      // Unreachable: say so. Answering from the hub's disk would be a guess
      // about another machine.
      return [
        {
          check: 'Computer reachable',
          ok: false,
          detail: `Couldn't ask the computer: ${err instanceof Error ? err.message : String(err)}`
        }
      ]
    }
  }
  facts ??= {
    problems: null,
    shellExists: inputs.hubLocal.shellExists(inputs.shell),
    binaries: await Promise.all(
      binaries.map(async (binary) => ({ binary, path: await inputs.hubLocal.which(binary) }))
    ),
    where: 'hub'
  }

  const rows: ValidationResult[] = []
  if (facts.problems) {
    rows.push(
      ...(facts.problems.length === 0
        ? [{ check: 'Terminal runtime', ok: true, detail: 'This computer can start terminals.' }]
        : facts.problems.map((p) => ({ check: p.check, ok: false, detail: p.detail, fix: p.fix })))
    )
  }
  if (inputs.missingShellOverride !== null) {
    rows.push({
      check: 'Shell detected',
      ok: false,
      detail: `Shell override not found: ${inputs.missingShellOverride}`,
      fix: 'Clear the shell override or set it to a valid absolute path'
    })
  } else if (!facts.shellExists) {
    rows.push({
      check: 'Shell detected',
      ok: false,
      detail:
        facts.where === 'computer'
          ? `${inputs.shell} not found on this computer`
          : `${inputs.shell} not found`,
      fix: 'Set SHELL to a valid shell path (for example /bin/zsh)'
    })
  }
  for (const requirement of inputs.requirements) {
    const path = facts.binaries.find((b) => b.binary === requirement.binary)?.path ?? null
    rows.push(
      path
        ? { check: requirement.check, ok: true, detail: path }
        : {
            check: requirement.check,
            ok: false,
            detail: `${requirement.binary} not found in PATH`,
            fix: requirement.fix
          }
    )
  }
  return rows
}
