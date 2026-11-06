/**
 * Doctor's rows for a task's agent.
 *
 * The agent starts on the task's COMPUTER, so its binary must be on that machine's
 * PATH, the shell the hub asks for must exist there, and that machine's node-pty
 * must be able to start ptys. Doctor used to run every check on the hub — the
 * wrong machine for a remote computer, and blind to a broken node-pty install
 * (every agent failing with "The computer couldn't start the agent." while Doctor
 * stayed green). The computer answers for itself (`pty.doctor`); with no computer
 * to ask, Doctor says "connect a computer" — never the hub's own PATH.
 */
import { expect, test, vi } from 'vitest'
import { getAdapter } from '../adapters'
import type { DoctorBinaryRequirement } from '../adapters/types'
import type { ComputerDoctorFacts } from './pty-backend'
import { runDoctor } from './runtime-doctor'

const claude: DoctorBinaryRequirement = {
  binary: 'claude',
  check: 'Binary found',
  fix: 'npm install -g @anthropic-ai/claude-code'
}
const helper = {
  check: 'spawn-helper executable',
  detail: '/h/spawn-helper is not executable.',
  fix: "chmod +x '/h/spawn-helper'"
}

function computer(facts: Partial<ComputerDoctorFacts> | null | Error) {
  const doctor = vi.fn(async () => {
    if (facts instanceof Error) throw facts
    return facts === null ? null : { problems: [], shellExists: true, binaries: [], ...facts }
  })
  return { doctor }
}

const inputs = (over: Partial<Parameters<typeof runDoctor>[0]> = {}) => ({
  requirements: [claude],
  computerId: 'computer-1',
  backend: computer({}),
  shell: '/bin/zsh',
  ...over
})

test('asks the computer for the shell and binaries the agent will need there', async () => {
  const backend = computer({ binaries: [{ binary: 'claude', path: '/c/bin/claude' }] })
  const rows = await runDoctor(inputs({ backend }))

  expect(backend.doctor).toHaveBeenCalledWith('computer-1', {
    shell: '/bin/zsh',
    binaries: ['claude']
  })
  expect(rows).toEqual([
    { check: 'Terminal runtime', ok: true, detail: 'This computer can start terminals.' },
    { check: 'Binary found', ok: true, detail: '/c/bin/claude' }
  ])
})

test("a broken node-pty install and a missing binary each fail with the computer's fix", async () => {
  const rows = await runDoctor(
    inputs({
      backend: computer({ problems: [helper], binaries: [{ binary: 'claude', path: null }] })
    })
  )
  expect(rows).toEqual([
    { check: helper.check, ok: false, detail: helper.detail, fix: helper.fix },
    { check: 'Binary found', ok: false, detail: 'claude not found in PATH', fix: claude.fix }
  ])
})

test('a shell the computer does not have fails, naming it', async () => {
  const rows = await runDoctor(inputs({ backend: computer({ shellExists: false }) }))
  expect(rows).toContainEqual(
    expect.objectContaining({
      check: 'Shell detected',
      ok: false,
      detail: '/bin/zsh not found on this computer'
    })
  )
})

const noComputerRow = {
  check: 'Computer connected',
  ok: false,
  detail: expect.stringMatching(/Connect a computer/)
}

test('no computer for the task: "connect a computer" — never the hub\'s own PATH', async () => {
  const backend = computer({})
  const rows = await runDoctor(inputs({ computerId: null, backend }))
  expect(backend.doctor).not.toHaveBeenCalled()
  expect(rows).toEqual([noComputerRow])
})

test('a computer that predates pty.doctor: no answer to give — "connect a computer"', async () => {
  const rows = await runDoctor(inputs({ backend: computer(null) }))
  expect(rows).toEqual([noComputerRow])
})

test('an unreachable computer is one failing row, not a thrown Doctor or a guess', async () => {
  const rows = await runDoctor(inputs({ backend: computer(new Error('connection closed')) }))
  expect(rows).toEqual([
    {
      check: 'Computer reachable',
      ok: false,
      detail: "Couldn't ask the computer: connection closed"
    }
  ])
})

test('every agent adapter declares what Doctor checks (claude-code shown)', () => {
  expect(getAdapter({ mode: 'claude-code' }).doctorRequirements).toEqual([claude])
  expect(
    getAdapter({ mode: 'codex' }).doctorRequirements?.map((r) => r.binary),
    'codex needs node too'
  ).toEqual(['node', 'codex'])
})
