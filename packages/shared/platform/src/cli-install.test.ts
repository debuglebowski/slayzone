import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import type { CliInstallResult } from './cli-install'

// Mock child_process.execFile before importing module under test
const mockExecFile = vi.fn()
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return { ...actual, execFile: mockExecFile }
})

// Mock fs — default to EACCES on mkdirSync so elevation path is reached
const mockMkdirSync = vi.fn()
const mockExistsSync = vi.fn(() => true)
const mockSymlinkSync = vi.fn()
const mockUnlinkSync = vi.fn()
const mockRealpathSync = vi.fn((p: string) => p)
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
      symlinkSync: (...args: unknown[]) => mockSymlinkSync(...args),
      unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
      realpathSync: (...args: unknown[]) => mockRealpathSync(...args),
    }
  }
})

const originalPlatform = process.platform

function setPlatform(p: string) {
  Object.defineProperty(process, 'platform', { value: p, writable: true, configurable: true })
}

function eaccesError(): NodeJS.ErrnoException {
  const err = new Error('EACCES') as NodeJS.ErrnoException
  err.code = 'EACCES'
  return err
}

function execError(opts: { code?: number; stderr?: string; message?: string }): Error & { code?: number; stderr?: string } {
  const err = new Error(opts.message ?? 'exec failed') as Error & { code?: number; stderr?: string }
  if (opts.code !== undefined) err.code = opts.code
  if (opts.stderr !== undefined) err.stderr = opts.stderr
  return err
}

// Make mockExecFile work with promisify: callback is the last argument
function mockExecFileSuccess() {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void
    cb(null, '', '')
  })
}

function mockExecFileFailure(err: Error) {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null) => void
    cb(err)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setPlatform(originalPlatform)
  // Default: mkdirSync succeeds, existsSync returns true
  mockMkdirSync.mockReturnValue(undefined)
  mockExistsSync.mockReturnValue(true)
  mockSymlinkSync.mockReturnValue(undefined)
  mockUnlinkSync.mockReturnValue(undefined)
  mockRealpathSync.mockImplementation((p: string) => p)
  // Put binDir in PATH so pathNotInPATH doesn't complicate assertions
  process.env.PATH = `/usr/local/bin:/usr/bin`
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('installCli', () => {
  // Dynamic import to get fresh module with mocks applied
  async function getInstallCli() {
    const mod = await import('./cli-install')
    return mod.installCli
  }

  test('sync success → no elevation attempted', async () => {
    setPlatform('darwin')
    const installCli = await getInstallCli()
    const result = await installCli('/app/bin/slay')

    expect(result.ok).toBe(true)
    expect(result.path).toBe('/usr/local/bin/slay')
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  test('macOS EACCES → osascript elevation succeeds', async () => {
    setPlatform('darwin')
    mockMkdirSync.mockImplementation(() => { throw eaccesError() })
    mockExecFileSuccess()

    const installCli = await getInstallCli()
    const result = await installCli('/app/bin/slay')

    expect(result.ok).toBe(true)
    expect(result.path).toBe('/usr/local/bin/slay')
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    expect(mockExecFile.mock.calls[0][0]).toBe('/usr/bin/osascript')
  })

  test('macOS user cancels password dialog → elevationCancelled', async () => {
    setPlatform('darwin')
    mockMkdirSync.mockImplementation(() => { throw eaccesError() })
    mockExecFileFailure(execError({ code: 1, stderr: 'User canceled' }))

    const installCli = await getInstallCli()
    const result = await installCli('/app/bin/slay')

    expect(result).toEqual({ ok: false, elevationCancelled: true })
  })

  test('macOS elevation fails (other error) → falls back to permissionDenied', async () => {
    setPlatform('darwin')
    mockMkdirSync.mockImplementation(() => { throw eaccesError() })
    mockExecFileFailure(execError({ code: 1, stderr: 'some other error' }))

    const installCli = await getInstallCli()
    const result = await installCli('/app/bin/slay')

    expect(result.ok).toBe(false)
    expect(result.permissionDenied).toBe(true)
    expect(result.error).toContain('sudo ln -sf')
  })

  test('Linux EACCES → pkexec elevation succeeds', async () => {
    setPlatform('linux')
    mockMkdirSync.mockImplementation(() => { throw eaccesError() })
    mockExecFileSuccess()
    process.env.PATH = `${process.env.HOME}/.local/bin:/usr/bin`

    const installCli = await getInstallCli()
    const result = await installCli('/app/bin/slay')

    expect(result.ok).toBe(true)
    expect(mockExecFile).toHaveBeenCalledTimes(1)
    expect(mockExecFile.mock.calls[0][0]).toBe('pkexec')
  })

  test('Linux user cancels polkit dialog (code 126) → elevationCancelled', async () => {
    setPlatform('linux')
    mockMkdirSync.mockImplementation(() => { throw eaccesError() })
    mockExecFileFailure(execError({ code: 126 }))

    const installCli = await getInstallCli()
    const result = await installCli('/app/bin/slay')

    expect(result).toEqual({ ok: false, elevationCancelled: true })
  })

  test('Linux pkexec not found (ENOENT) → falls back to permissionDenied', async () => {
    setPlatform('linux')
    mockMkdirSync.mockImplementation(() => { throw eaccesError() })
    const err = execError({ message: 'spawn pkexec ENOENT' }) as NodeJS.ErrnoException
    err.code = 'ENOENT' as unknown as number // execFile ENOENT uses string code
    mockExecFileFailure(err)

    const installCli = await getInstallCli()
    const result = await installCli('/app/bin/slay')

    expect(result.ok).toBe(false)
    expect(result.permissionDenied).toBe(true)
    expect(result.error).toContain('ln -sf')
  })

  test('Windows EACCES → no elevation, straight to permissionDenied', async () => {
    setPlatform('win32')
    mockMkdirSync.mockImplementation(() => { throw eaccesError() })

    const installCli = await getInstallCli()
    const result = await installCli('/app/bin/slay')

    expect(result.ok).toBe(false)
    expect(result.permissionDenied).toBe(true)
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})
