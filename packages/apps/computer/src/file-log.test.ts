import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMPUTER_LOG_DIR_NAME,
  COMPUTER_LOG_FILE_NAME,
  appendComputerLogSync,
  createComputerFileLog,
  createComputerLog,
  installProcessFateLog,
  rotateLogFile,
  type FateLoggedProcess
} from './file-log'
import { sessionHostLog } from './session-host'

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
}

describe('computer file log', () => {
  it('appends each line, timestamped, under <stateDir>/logs', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'computer-log-'))
    const log = createComputerFileLog(stateDir)
    log('agent start admitted {"waitedMs":1200}')
    const file = join(stateDir, COMPUTER_LOG_DIR_NAME, COMPUTER_LOG_FILE_NAME)
    const read = () => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return ''
      }
    }
    await until(() => read().includes('admitted'))
    expect(read()).toMatch(/^\d{4}-\d\d-\d\dT[^ ]+ agent start admitted \{"waitedMs":1200\}\n$/)
  })

  it('an unusable state dir gives a no-op, never a throw', () => {
    const blocker = join(mkdtempSync(join(tmpdir(), 'computer-log-')), 'a-file')
    writeFileSync(blocker, '')
    const log = createComputerFileLog(blocker)
    expect(() => log('still running')).not.toThrow()
  })
})

describe('rotation while running (a computer runs for weeks; it used to rotate only when it opened the file)', () => {
  it('a log past its size goes to .1 and a new one starts', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'computer-log-'))
    const log = createComputerFileLog(stateDir, { maxBytes: 1000 })
    const file = join(stateDir, COMPUTER_LOG_DIR_NAME, COMPUTER_LOG_FILE_NAME)
    const size = () => (existsSync(file) ? statSync(file).size : 0)
    const text = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '')
    log(`line 0 ${'x'.repeat(40)}`)
    await until(() => text(file).includes('line 0'))
    // A turn between lines (the file opens asynchronously; a log's lines are not a
    // single synchronous burst).
    for (let i = 1; i < 20; i++) {
      log(`line ${i} ${'x'.repeat(40)}`)
      await new Promise((r) => setTimeout(r, 2))
    }
    log('the newest line')
    await until(() => text(file).includes('the newest line'))
    expect(existsSync(`${file}.1`)).toBe(true)
    expect(size()).toBeLessThanOrEqual(1000 + 120)
    // One cut (~1.6 KB written, 1 KB max), nothing lost: every line is in one of the two.
    await until(() => text(`${file}.1`).length > 0)
    const both = text(`${file}.1`) + text(file)
    for (let i = 0; i < 20; i++) expect(both).toContain(`line ${i} `)
  })

  it('rotateLogFile: over the size → .1; under it, or missing, untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'computer-log-'))
    const big = join(dir, 'host.log')
    writeFileSync(big, 'x'.repeat(500))
    rotateLogFile(big, 100)
    expect(existsSync(big)).toBe(false)
    expect(readFileSync(`${big}.1`, 'utf8')).toHaveLength(500)
    const small = join(dir, 'small.log')
    writeFileSync(small, 'ok')
    rotateLogFile(small, 100)
    expect(readFileSync(small, 'utf8')).toBe('ok')
    expect(() => rotateLogFile(join(dir, 'missing.log'), 100)).not.toThrow()
  })
})

describe('one computer log for every process that runs the computer', () => {
  it('createComputerLog: the line, tagged, to stdout and, timestamped, to computer.log', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'computer-log-'))
    const out: string[] = []
    const log = createComputerLog({ stateDir, tag: 'computer', stdout: (s) => out.push(s) })
    log('started', { pid: 1 })
    log('plain')
    expect(out).toEqual(['[computer] started {"pid":1}\n', '[computer] plain\n'])
    const file = join(stateDir, COMPUTER_LOG_DIR_NAME, COMPUTER_LOG_FILE_NAME)
    await until(() => existsSync(file) && readFileSync(file, 'utf8').includes('plain'))
    // The file is shared by every computer process: each line names its writer.
    const tag = `\\[computer ${process.pid}\\]`
    expect(readFileSync(file, 'utf8')).toMatch(
      new RegExp(`^\\S+ ${tag} started \\{"pid":1\\}\\n\\S+ ${tag} plain\\n$`)
    )
  })

  it('the standalone session host logs to <root>/logs/computer.log, not only stdout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'computer-log-'))
    mkdirSync(join(root, 'computer-runtime'), { recursive: true })
    const out: string[] = []
    const log = sessionHostLog(root, (s) => out.push(s))
    log('connected to hub', { hubUrl: 'ws://127.0.0.1:1/computers' })
    expect(out).toEqual(['[host] connected to hub {"hubUrl":"ws://127.0.0.1:1/computers"}\n'])
    const file = join(root, COMPUTER_LOG_DIR_NAME, COMPUTER_LOG_FILE_NAME)
    await until(() => existsSync(file) && readFileSync(file, 'utf8').includes('connected'))
    expect(readFileSync(file, 'utf8')).toContain('connected to hub {"hubUrl"')
  })
})

describe('how a computer process ends is in computer.log (it used to reach only stderr)', () => {
  const fakeProcess = (): FateLoggedProcess & EventEmitter =>
    Object.assign(new EventEmitter(), { pid: 4242 }) as FateLoggedProcess & EventEmitter
  const logText = (stateDir: string): string =>
    readFileSync(join(stateDir, COMPUTER_LOG_DIR_NAME, COMPUTER_LOG_FILE_NAME), 'utf8')

  it('a fatal error: origin, code and stack, written before the process is gone', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'computer-log-'))
    const proc = fakeProcess()
    installProcessFateLog({ stateDir, tag: 'host', proc })
    const err = Object.assign(new Error('listen EADDRINUSE: address already in use /tmp/x.sock'), {
      code: 'EADDRINUSE'
    })
    proc.emit('uncaughtExceptionMonitor', err, 'uncaughtException')
    // Synchronous: readable at once, no stream to flush.
    const line = logText(stateDir)
    expect(line).toMatch(/^\S+ \[host 4242\] fatal error \{/)
    const meta = JSON.parse(line.slice(line.indexOf('{')))
    expect(meta).toMatchObject({
      origin: 'uncaughtException',
      code: 'EADDRINUSE'
    })
    expect(meta.error).toContain('listen EADDRINUSE')
    expect(meta.error).toContain('file-log.test.ts')
  })

  it('an unhandled rejection of a non-Error is recorded too', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'computer-log-'))
    const proc = fakeProcess()
    installProcessFateLog({ stateDir, tag: 'computer', proc })
    proc.emit('uncaughtExceptionMonitor', 'boom', 'unhandledRejection')
    expect(logText(stateDir)).toContain(
      'fatal error {"origin":"unhandledRejection","error":"boom"}'
    )
  })

  it('the exit: code and how long the process ran', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'computer-log-'))
    const proc = fakeProcess()
    let t = 1_000
    installProcessFateLog({ stateDir, tag: 'supervisor', proc, now: () => t })
    t = 61_000
    proc.emit('exit', 1)
    expect(logText(stateDir)).toMatch(
      /^\S+ \[supervisor 4242\] process exit \{"code":1,"uptimeMs":60000\}\n$/
    )
  })

  it('appendComputerLogSync never throws on an unusable state dir', () => {
    const blocker = join(mkdtempSync(join(tmpdir(), 'computer-log-')), 'a-file')
    writeFileSync(blocker, '')
    expect(() => appendComputerLogSync(blocker, 'x')).not.toThrow()
  })
})
