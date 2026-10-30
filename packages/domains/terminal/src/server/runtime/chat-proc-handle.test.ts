/**
 * The in-process `ChatProcHandle`: a real child behind the same contract the
 * routed one has — whole characters, confirmed writes, typed start failures.
 */
import { spawn } from 'node:child_process'
import { expect, test } from 'vitest'
import {
  childProcessToHandle,
  createLineSplitter,
  createLocalChatBackend,
  isChatSpawnError
} from './chat-proc-handle'

function collect(handle: ReturnType<typeof childProcessToHandle>) {
  const out: string[] = []
  const err: string[] = []
  handle.onStdout((c) => out.push(c))
  handle.onStderr((c) => err.push(c))
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    handle.onExit(resolve)
  )
  return { out, err, exited }
}

test('a UTF-8 character split across two reads arrives whole', async () => {
  const child = spawn(
    'sh',
    [
      '-c',
      "printf 'h\\303'; sleep 0.2; printf '\\251llo'; printf 'w\\303' 1>&2; sleep 0.2; printf '\\266rd' 1>&2"
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  const { out, err, exited } = collect(childProcessToHandle(child))
  await exited
  expect(out.some((c) => c.includes('�') || c === '')).toBe(false)
  expect(out.join('')).toBe('héllo')
  expect(err.join('')).toBe('wörd')
})

test('a write resolves once the bytes reached the process', async () => {
  const child = spawn('cat', [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const handle = childProcessToHandle(child)
  const { out } = collect(handle)
  await expect(handle.write('ping\n')).resolves.toBeUndefined()
  await expect.poll(() => out.join('')).toBe('ping\n')
  handle.kill('SIGKILL')
})

test('a write to a process that closed stdin rejects instead of crashing the hub', async () => {
  const child = spawn('sh', ['-c', 'exec 0<&-; sleep 2'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const handle = childProcessToHandle(child)
  await new Promise((r) => setTimeout(r, 150))
  await expect(handle.write('x'.repeat(256 * 1024))).rejects.toThrow()
  await expect(handle.write('y')).rejects.toThrow()
  handle.kill('SIGKILL')
})

test('a write after the process exited rejects', async () => {
  const child = spawn('sh', ['-c', 'exit 0'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const handle = childProcessToHandle(child)
  const { exited } = collect(handle)
  await exited
  await expect(handle.write('late\n')).rejects.toThrow()
})

test('a binary that is not installed is a typed start failure', async () => {
  const backend = createLocalChatBackend({ whichBinary: async () => null })
  const err = await Promise.resolve(
    backend.spawn({
      sessionId: 't:1',
      taskId: 't',
      computerId: null,
      binaryName: 'claude',
      args: [],
      cwd: '/tmp',
      env: {}
    })
  ).then(
    () => null,
    (e: unknown) => e
  )
  expect(isChatSpawnError(err)).toBe(true)
  expect(err).toMatchObject({ code: 'cli-not-installed', binary: 'claude' })
})

test('an exec failure after spawn (ENOENT) reaches onError as a typed failure', async () => {
  const child = spawn('definitely-not-a-real-binary-xyz', [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const handle = childProcessToHandle(child)
  const err = await new Promise<Error>((resolve) => handle.onError(resolve))
  expect(isChatSpawnError(err)).toBe(true)
  expect(err).toMatchObject({ code: 'cli-not-installed' })
})

// ---- line splitting (an echoed attachment can be one line of tens of MB) ----

function split(chunks: string[]): string[] {
  const lines: string[] = []
  const feed = createLineSplitter((l) => lines.push(l))
  for (const c of chunks) feed(c)
  return lines
}

test('lines: several per chunk, one across chunks, CRLF (also split between chunks), no partial tail', () => {
  expect(split(['a\nb', 'c\r', '\nd\n', 'tail'])).toEqual(['a', 'bc', 'd'])
  expect(split(['x\r\n\r\n'])).toEqual(['x', ''])
})

test('a huge line arrives whole', () => {
  const big = 'Q'.repeat(8 * 1024 * 1024)
  const chunks: string[] = []
  for (let i = 0; i < big.length; i += 64 * 1024) chunks.push(big.slice(i, i + 64 * 1024))
  const lines = split([...chunks, '\nnext\n'])
  expect(lines).toHaveLength(2)
  expect(lines[0].length).toBe(big.length)
  expect(lines[1]).toBe('next')
})

test("work grows linearly with a line's size (no rescan of what was already buffered)", () => {
  const time = (bytes: number): number => {
    const chunk = 'Q'.repeat(64 * 1024)
    const feed = createLineSplitter(() => undefined)
    const t = performance.now()
    for (let i = 0; i < bytes; i += chunk.length) feed(chunk)
    feed('\n')
    return performance.now() - t
  }
  time(1024 * 1024) // warm up
  const small = Math.max(time(4 * 1024 * 1024), 1)
  const large = time(16 * 1024 * 1024)
  // 4× the bytes: linear ≈ 4×; rescanning the buffer every chunk ≈ 16×.
  expect(large / small).toBeLessThan(9)
})
