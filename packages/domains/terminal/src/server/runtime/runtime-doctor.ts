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
 * `pty.doctor` — Doctor says so ("connect a computer"): the hub's own PATH says
 * nothing about the machine the agent starts on.
 *
 * @module terminal/server/runtime/runtime-doctor
 */

import type { ValidationResult } from '@slayzone/terminal-contracts'
import { NO_COMPUTER_MESSAGE } from '@slayzone/platform/hub-switch-refusal'
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
}

type Facts = Omit<ComputerDoctorFacts, 'problems'> & {
  problems: ComputerDoctorFacts['problems'] | null
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
      if (answered) facts = answered
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
  if (!facts) {
    return [{ check: 'Computer connected', ok: false, detail: NO_COMPUTER_MESSAGE }]
  }

  const rows: ValidationResult[] = []
  if (facts.problems) {
    rows.push(
      ...(facts.problems.length === 0
        ? [{ check: 'Terminal runtime', ok: true, detail: 'This computer can start terminals.' }]
        : facts.problems.map((p) => ({ check: p.check, ok: false, detail: p.detail, fix: p.fix })))
    )
  }
  if (!facts.shellExists) {
    rows.push({
      check: 'Shell detected',
      ok: false,
      detail: `${inputs.shell} not found on this computer`,
      fix: 'Set SHELL (or the shell override) to a valid shell path on it (for example /bin/zsh)'
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
