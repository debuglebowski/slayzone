import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const terminal = vi.hoisted(() => ({
  spawn: vi.fn(),
  write: vi.fn(),
  kill: vi.fn(),
  data: (_data: string) => {},
  exit: (_event: { exitCode: number }) => {}
}))
vi.mock('./node-pty', () => ({ spawnNodePty: terminal.spawn }))
import { probeNativeTerminal } from './native-probe'

beforeEach(() => {
  vi.useFakeTimers()
  terminal.spawn.mockReset().mockReturnValue({
    write: terminal.write.mockReset(),
    kill: terminal.kill.mockReset(),
    onData: (callback: typeof terminal.data) => {
      terminal.data = callback
      return { dispose() {} }
    },
    onExit: (callback: typeof terminal.exit) => {
      terminal.exit = callback
      return { dispose() {} }
    }
  })
})
afterEach(() => vi.useRealTimers())

it('requires terminal output and a successful exit after acknowledging readiness', async () => {
  const probe = probeNativeTerminal()
  await vi.waitFor(() => expect(terminal.spawn).toHaveBeenCalled())
  expect(terminal.spawn.mock.calls[0][1][1]).toContain("stdin.once('data'")
  terminal.data('slayzone-native-')
  expect(terminal.write).not.toHaveBeenCalled()
  terminal.data('probe-ready')
  expect(terminal.write).toHaveBeenCalledOnce()
  terminal.exit({ exitCode: 0 })
  await expect(probe).resolves.toBeUndefined()
})

it('rejects a clean exit without a working terminal data path', async () => {
  const probe = probeNativeTerminal()
  await vi.waitFor(() => expect(terminal.spawn).toHaveBeenCalled())
  const result = expect(probe).rejects.toThrow('native terminal probe failed')
  terminal.exit({ exitCode: 0 })
  await result
})

it('times out a stuck terminal and kills it', async () => {
  const probe = probeNativeTerminal()
  await vi.waitFor(() => expect(terminal.spawn).toHaveBeenCalled())
  const result = expect(probe).rejects.toThrow('native terminal probe timed out')
  await vi.advanceTimersByTimeAsync(10_000)
  await result
  expect(terminal.kill).toHaveBeenCalledOnce()
})
