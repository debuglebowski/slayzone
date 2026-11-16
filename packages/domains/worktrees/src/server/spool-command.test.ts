import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureGitExec, spoolCommand } from './exec-async'

const io = vi.hoisted(() => ({
  blocked: false,
  fail: false,
  bytesRead: 0,
  release: undefined as (() => void) | undefined,
  firstWrite: undefined as (() => void) | undefined,
  children: [] as ChildProcess[]
}))

vi.mock('child_process', async (original) => {
  const cp = await original<typeof import('node:child_process')>()
  return {
    ...cp,
    spawn: (...args: Parameters<typeof cp.spawn>) => {
      const child = cp.spawn(...args)
      io.children.push(child)
      if (child.stdout) {
        const read = child.stdout.read.bind(child.stdout)
        child.stdout.read = (size?: number) => {
          const chunk = read(size)
          if (Buffer.isBuffer(chunk)) io.bytesRead += chunk.length
          return chunk
        }
      }
      return child
    }
  }
})

vi.mock('fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => {
      const out = fs.createWriteStream(...args)
      // Keep the red run alive so assertions can diagnose the missing error path.
      out.on('error', () => undefined)
      const write = out._write.bind(out)
      out._write = (chunk, encoding, done) => {
        io.firstWrite?.()
        if (io.fail) return done(new Error('disk full'))
        if (io.blocked && !io.release)
          io.release = () => {
            io.release = undefined
            io.blocked = false
            write(chunk, encoding, done)
          }
        else write(chunk, encoding, done)
      }
      return out
    }
  }
})

let dir: string
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function stopChildren() {
  for (const child of io.children) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const closed = once(child, 'close').catch(() => undefined)
    child.kill('SIGKILL')
    await closed
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spool-command-'))
  Object.assign(io, {
    blocked: false,
    fail: false,
    bytesRead: 0,
    release: undefined,
    firstWrite: undefined,
    children: []
  })
  configureGitExec({ refuse: () => undefined, loginShellPath: () => null, diagnostic: () => {} })
})
afterEach(async () => {
  io.release?.()
  await stopChildren()
  configureGitExec(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('spoolCommand', () => {
  it('a stalled disk bounds stdout consumption, then writes every byte after resuming', async () => {
    const size = 16 * 1024 * 1024
    io.blocked = true
    const first = new Promise<void>((resolve) => {
      io.firstWrite = resolve
    })
    const file = join(dir, 'output')
    const pending = spoolCommand(
      process.execPath,
      ['-e', `process.stdout.write(Buffer.alloc(${size},65))`],
      { cwd: dir },
      file
    )
    try {
      await first
      await pause(250)
      expect(io.bytesRead).toBeLessThan(1024 * 1024)
    } finally {
      io.blocked = false
      io.release?.()
      await pending
    }
    expect(await pending).toBe(size)
    expect(readFileSync(file).equals(Buffer.alloc(size, 65))).toBe(true)
  })

  it('a disk failure stops the producer and removes its partial spool', async () => {
    io.fail = true
    const file = join(dir, 'partial')
    const pending = spoolCommand(
      process.execPath,
      ['-e', "process.stdout.write('partial'); setInterval(()=>{},1000)"],
      { cwd: dir },
      file
    ).catch((err: Error) => err)
    try {
      const outcome = await Promise.race([pending, pause(2000).then(() => 'timeout')])
      expect(outcome).toMatchObject({ message: 'disk full' })
      expect(io.children[0].exitCode !== null || io.children[0].signalCode !== null).toBe(true)
      expect(existsSync(file)).toBe(false)
    } finally {
      await stopChildren()
      await pending
    }
  })

  it('a missing command rejects and leaves no empty spool', async () => {
    const file = join(dir, 'missing')
    await expect(spoolCommand(join(dir, 'no-command'), [], { cwd: dir }, file)).rejects.toThrow()
    await pause(20)
    expect(existsSync(file)).toBe(false)
  })
})
