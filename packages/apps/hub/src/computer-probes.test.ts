/**
 * Terminal settings probes run where agents start — the caller's computer, as one
 * `exec.run` — never on the hub's own PATH: a terminal mode's binary (`which`) and
 * a docker / ssh execution context. No computer: "connect a computer".
 */
import { expect, test, vi } from 'vitest'
import { isHubSwitchedOffError } from '@slayzone/platform/hub-switch-refusal'
import { createComputerProbes } from './computer-probes'

const ok = (stdout: string) => ({ stdout, stderr: '', status: 0, timedOut: false })
const fail = (stderr: string, status = 1) => ({ stdout: '', stderr, status, timedOut: false })

test('command probe: `command -v` on the computer; its path is the answer', async () => {
  const run = vi.fn(async () => ok('/c/bin/claude\n'))
  const probes = createComputerProbes({ computerFor: async () => 'c1', run })
  expect(await probes.command('claude')).toEqual({ found: true, path: '/c/bin/claude' })
  expect(run).toHaveBeenCalledWith('c1', {
    command: 'command -v claude || where claude',
    timeoutMs: 10_000
  })
})

test('command probe: absent on the computer → not found, with its stderr', async () => {
  const probes = createComputerProbes({
    computerFor: async () => 'c1',
    run: async () => fail('nope')
  })
  expect(await probes.command('ghost')).toEqual({ found: false, error: 'nope' })
})

test("a name with shell characters is quoted, so it can't run anything else", async () => {
  const commands: string[] = []
  const probes = createComputerProbes({
    computerFor: async () => 'c1',
    run: async (_id, params) => {
      commands.push(params.command)
      return ok('')
    }
  })
  await probes.command("x'; rm -rf ~; '")
  expect(commands[0]).toBe(
    "command -v 'x'\\''; rm -rf ~; '\\''' || where 'x'\\''; rm -rf ~; '\\'''"
  )
})

test('execution-context probe: the docker / ssh check runs on the computer', async () => {
  const run = vi.fn(async () => ok('ok\n'))
  const probes = createComputerProbes({ computerFor: async () => 'c1', run })
  expect(await probes.executionContext('docker', ['exec', '--', 'web', 'echo', 'ok'])).toEqual({
    success: true
  })
  expect(run).toHaveBeenCalledWith('c1', {
    command: 'docker exec -- web echo ok',
    timeoutMs: 10_000
  })
  const failing = createComputerProbes({
    computerFor: async () => 'c1',
    run: async () => fail('No such container: web')
  })
  expect(await failing.executionContext('docker', ['exec'])).toEqual({
    success: false,
    error: 'No such container: web'
  })
  const slow = createComputerProbes({
    computerFor: async () => 'c1',
    run: async () => ({ stdout: '', stderr: '', status: null, timedOut: true })
  })
  expect(await slow.executionContext('ssh', [])).toEqual({ success: false, error: 'Timed out' })
})

test('no computer: "connect a computer", nothing run', async () => {
  const run = vi.fn(async () => ok(''))
  const probes = createComputerProbes({ computerFor: async () => null, run })
  for (const call of [() => probes.command('git'), () => probes.executionContext('ssh', [])]) {
    const err = await call().then(
      () => null,
      (e: unknown) => e
    )
    expect(isHubSwitchedOffError(err), `expected the no-computer refusal, got ${err}`).toBe(true)
  }
  expect(run).not.toHaveBeenCalled()
})
