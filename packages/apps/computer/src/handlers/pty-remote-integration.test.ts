import { userInfo } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { setShellOverride } from '@slayzone/platform'
import { TypedEventEmitter } from '@slayzone/computer-transport/shared'
import { createRoutingPtyBackend, type RoutingGateway } from '@slayzone/computer-transport/server'
import type { ComputerGatewayEvents } from '@slayzone/computer-transport/server'
import type { PtyHandle, PtySignal, PtySpawnSpec } from '@slayzone/terminal/server'
import { createPtyHandlers } from './pty'
import type { ComputerConfig } from '../config'
import type { ComputerDialer } from './types'

const computerId = 'remote-computer'
const sessionId = 'task:tab'

function setup() {
  const events = new TypedEventEmitter<ComputerGatewayEvents>()
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'remote',
    allowedRoots: [process.cwd()],
    capabilities: ['pty']
  }
  const dialer: ComputerDialer = {
    notify: (method, params) => {
      events.emit(
        method as 'pty.data',
        {
          ...(params as Record<string, unknown>),
          computerId
        } as ComputerGatewayEvents['pty.data']
      )
      return true
    }
  }
  const computer = createPtyHandlers({ dialer, config, log: () => {} })
  const gateway = {
    events,
    listComputers: () => [],
    request: async (_id: string, method: string, params: unknown) =>
      computer.handlers[method]!(params)
  } as RoutingGateway
  const backend = createRoutingPtyBackend({
    gateway,
    resolveComputerId: (spec) => spec.computerId
  })
  const spec: PtySpawnSpec = {
    sessionId,
    taskId: 'task',
    computerId,
    projectId: null,
    // Deliberately unusable hub shell and hub identity: the computer must ignore both.
    file: '/usr/sbin/nologin',
    args: [],
    options: {
      cwd: process.cwd(),
      env: {
        HOME: '/tmp',
        USER: 'slayzone',
        PATH: '/hub/bin',
        SLAYZONE_TASK_ID: 'task'
      },
      cols: 80,
      rows: 24,
      name: 'xterm-256color'
    },
    transport: false,
    computerShellCommand: 'printf "HOME=%s USER=%s PATH=%s\\n" "$HOME" "$USER" "$PATH"; exec cat'
  }
  return { backend, computer, spec }
}

describe('desktop hub to remote computer PTY', () => {
  // The computer's login shell is this machine's own: a user's rc files (an
  // oh-my-zsh "update? [Y/n]" prompt) blocked the command. /bin/sh reads none.
  beforeAll(() => setShellOverride('/bin/sh'))
  afterAll(() => setShellOverride(null))

  it('uses computer identity and keeps one live process across reload', async () => {
    const { backend, computer, spec } = setup()
    try {
      const first = (await backend.spawn(spec)) as PtyHandle
      const firstData: string[] = []
      first.onData((data) => firstData.push(data))
      await first.whenSpawned
      await vi.waitFor(
        () =>
          expect(firstData.join('')).toContain(
            `HOME=${userInfo().homedir} USER=${userInfo().username}`
          ),
        { timeout: 8_000 }
      )
      expect(firstData.join('')).not.toContain('/hub/bin')
      const firstPid = first.pid!

      const second = (await backend.spawn(spec)) as PtyHandle
      await second.whenSpawned
      expect(second.pid).not.toBe(firstPid)
      expect(() => process.kill(firstPid, 0)).toThrow()
      const listed = computer.handlers['pty.list']({}) as {
        sessions: Array<{ sessionId: string; pid: number }>
      }
      expect(listed.sessions).toEqual([expect.objectContaining({ sessionId, pid: second.pid })])

      // Late command from old handle must not reach the replacement.
      first.write('late input\n')
      first.kill()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect((computer.handlers['pty.list']({}) as typeof listed).sessions).toHaveLength(1)
      second.kill()
    } finally {
      computer.disposeAll()
    }
  }, 15_000)

  it('kills an adopted warm agent before acknowledging', async () => {
    const { backend, computer } = setup()
    try {
      const warm = await backend.warmSpawn!(computerId, {
        warmId: 'warm-1',
        projectId: 'p1',
        command: '/usr/sbin/nologin',
        args: [],
        cwd: process.cwd(),
        env: { HOME: '/tmp', SLAYZONE_TASK_ID: 'task' },
        postSpawnCommand: 'exec cat'
      })
      const adopted = await backend.adopt!(computerId, 'warm-1', sessionId, 'cat')
      expect(adopted.pid).toBe(warm.pid)
      adopted.kill()
      await vi.waitFor(() => expect(() => process.kill(warm.pid, 0)).toThrow())
      await vi.waitFor(() =>
        expect((computer.handlers['pty.list']({}) as { sessions: unknown[] }).sessions).toEqual([])
      )
    } finally {
      computer.disposeAll()
    }
  }, 15_000)

  it('output detection runs on the computer and reaches the hub handle as signals', async () => {
    const { backend, computer, spec } = setup()
    try {
      const handle = (await backend.spawn({
        ...spec,
        computerShellCommand:
          'printf "\\033]0;Codex busy\\007 serving http://0.0.0.0:5173\\n"; exec cat',
        detection: { mode: 'codex', resuming: false }
      })) as PtyHandle
      const signals: PtySignal[] = []
      const data: string[] = []
      handle.onSignal?.((s) => signals.push(s))
      handle.onData((d) => data.push(d))
      await handle.whenSpawned
      expect(handle.detectsOutput).toBe(true)
      await vi.waitFor(
        () =>
          expect(signals).toContainEqual(
            expect.objectContaining({
              title: 'Codex busy',
              devServerUrls: ['http://localhost:5173']
            })
          ),
        { timeout: 8_000 }
      )
      // The bytes still reach the hub for display.
      expect(data.join('')).toContain('serving http://0.0.0.0:5173')
      handle.kill()
    } finally {
      computer.disposeAll()
    }
  }, 15_000)

  it('a recovery spawn continues ONE scrollback on the computer, without re-delivering it', async () => {
    const { backend, computer, spec } = setup()
    try {
      const detection = { mode: 'claude-code', resuming: false }
      const agent = (await backend.spawn({
        ...spec,
        computerShellCommand: 'printf "agent-out\\n"; exit 1',
        detection
      })) as PtyHandle
      const exited = new Promise<void>((resolve) => agent.onExit(() => resolve()))
      await agent.whenSpawned
      await exited

      const shell = (await backend.spawn({
        ...spec,
        computerShellCommand: 'printf "shell-out\\n"; exec cat',
        detection,
        carryOutput: { preamble: '[agent exited]\r\n' }
      })) as PtyHandle
      const live: string[] = []
      shell.onData((d) => live.push(d))
      await shell.whenSpawned
      await vi.waitFor(() => expect(live.join('')).toContain('shell-out'), { timeout: 8_000 })
      // The continued scrollback is not delivered again as new output.
      expect(live.join('')).not.toContain('agent-out')
      expect(live.join('')).not.toContain('[agent exited]')

      const { frames } = computer.handlers['pty.getBufferSince']({ sessionId, seq: -1 }) as {
        frames: Array<{ seq: number; data: string }>
      }
      const text = frames.map((f) => f.data).join('')
      expect(text.indexOf('agent-out')).toBeGreaterThanOrEqual(0)
      expect(text.indexOf('agent-out')).toBeLessThan(text.indexOf('[agent exited]'))
      expect(text.indexOf('[agent exited]')).toBeLessThan(text.indexOf('shell-out'))
      const seqs = frames.map((f) => f.seq)
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      shell.kill()
    } finally {
      computer.disposeAll()
    }
  }, 20_000)

  it('without `detection` the handle reports none and the hub keeps detecting', async () => {
    const { backend, computer, spec } = setup()
    try {
      const handle = (await backend.spawn(spec)) as PtyHandle
      const signals: PtySignal[] = []
      handle.onSignal?.((s) => signals.push(s))
      await handle.whenSpawned
      expect(handle.detectsOutput).toBe(false)
      await new Promise((r) => setTimeout(r, 300))
      expect(signals).toEqual([])
      handle.kill()
    } finally {
      computer.disposeAll()
    }
  }, 15_000)
})
