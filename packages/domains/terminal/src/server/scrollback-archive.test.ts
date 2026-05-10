/**
 * Tests for ScrollbackArchive (per-tab disk-archived scrollback).
 * Run with: npx tsx packages/domains/terminal/src/main/scrollback-archive.test.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { ScrollbackArchive } from './scrollback-archive'

let passed = 0
let failed = 0

function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => { console.log(`  ✓ ${name}`); passed++ })
    .catch((e) => { console.log(`  ✗ ${name}`); console.error(`    ${e}`); failed++ })
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toEqual(expected: T) {
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toBeGreaterThan(threshold: number) {
      if (typeof actual !== 'number' || actual <= threshold)
        throw new Error(`Expected > ${threshold}, got ${actual}`)
    },
    toBeLessThanOrEqual(threshold: number) {
      if (typeof actual !== 'number' || actual > threshold)
        throw new Error(`Expected <= ${threshold}, got ${actual}`)
    },
  }
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scrollback-archive-test-'))
}

const TASK_ID = 'task00000000'
const TAB_ID = 'tab00000000'
const STABLE_ID = `${TASK_ID}:${TAB_ID}`

async function run() {
  console.log('ScrollbackArchive')

  await test('append + getTailLines returns last N lines', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    archive.append(STABLE_ID, 'line1\nline2\nline3\nline4\nline5\n')
    const tail = await archive.getTailLines(STABLE_ID, 3)
    expect(tail.data).toBe('line3\nline4\nline5\n')
    expect(tail.totalSize).toBe(30)
    expect(tail.earliestOffset).toBe(12)
    await archive.closeStream(STABLE_ID)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('getTailLines with N >= total returns whole file', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    archive.append(STABLE_ID, 'a\nb\nc\n')
    const tail = await archive.getTailLines(STABLE_ID, 100)
    expect(tail.data).toBe('a\nb\nc\n')
    expect(tail.earliestOffset).toBe(0)
    await archive.closeStream(STABLE_ID)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('getTailLines on empty/missing file returns empty', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    const tail = await archive.getTailLines(STABLE_ID, 10)
    expect(tail.data).toBe('')
    expect(tail.totalSize).toBe(0)
    expect(tail.earliestOffset).toBe(0)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('getTailLines handles file without trailing newline', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    archive.append(STABLE_ID, 'line1\nline2\nlast-line-no-nl')
    const tail = await archive.getTailLines(STABLE_ID, 2)
    expect(tail.data).toBe('line2\nlast-line-no-nl')
    await archive.closeStream(STABLE_ID)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('getTailLines on single-line file', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    archive.append(STABLE_ID, 'only-line\n')
    const tail = await archive.getTailLines(STABLE_ID, 5)
    expect(tail.data).toBe('only-line\n')
    expect(tail.earliestOffset).toBe(0)
    await archive.closeStream(STABLE_ID)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('getRangeLinesBefore returns older slice', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    archive.append(STABLE_ID, 'a\nb\nc\nd\ne\nf\ng\nh\n')
    // Tail: last 3 → 'f\ng\nh\n'. earliestOffset = 10.
    const tail = await archive.getTailLines(STABLE_ID, 3)
    expect(tail.data).toBe('f\ng\nh\n')
    // Load 3 more before that.
    const range = await archive.getRangeLinesBefore(STABLE_ID, tail.earliestOffset, 3)
    expect(range.data).toBe('c\nd\ne\n')
    expect(range.earliestOffset).toBe(4)
    await archive.closeStream(STABLE_ID)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('getRangeLinesBefore at offset 0 returns empty', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    archive.append(STABLE_ID, 'a\nb\nc\n')
    const range = await archive.getRangeLinesBefore(STABLE_ID, 0, 5)
    expect(range.data).toBe('')
    expect(range.earliestOffset).toBe(0)
    await archive.closeStream(STABLE_ID)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('rotation drops oldest bytes when cap exceeded', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    // Cap 4MB so rotation drops 2MB. Each line: 100 bytes → 1MB ≈ 10000 lines.
    archive.setCapBytes(4 * 1024 * 1024)
    const line = 'x'.repeat(99) + '\n' // 100 bytes
    // Write ~5MB worth to trigger rotation.
    for (let i = 0; i < 60000; i++) archive.append(STABLE_ID, line)
    // Wait for rotation to settle.
    await new Promise((r) => setTimeout(r, 200))
    // Drain pending writes by querying tail (forces drain).
    const tail = await archive.getTailLines(STABLE_ID, 1)
    // After rotation, file size should be at most cap.
    const filePath = path.join(dir, TASK_ID, `${TAB_ID}.log`)
    const stats = fs.statSync(filePath)
    expect(stats.size).toBeLessThanOrEqual(4 * 1024 * 1024 + 200 * 1024) // small slack
    expect(tail.data).toBe(line)
    await archive.closeStream(STABLE_ID)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('rotation preserves \\n boundary (no partial-line corruption)', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    archive.setCapBytes(2 * 1024 * 1024)
    const line = 'y'.repeat(99) + '\n'
    for (let i = 0; i < 30000; i++) archive.append(STABLE_ID, line)
    await new Promise((r) => setTimeout(r, 200))
    await archive.getTailLines(STABLE_ID, 1)
    const filePath = path.join(dir, TASK_ID, `${TAB_ID}.log`)
    const buf = fs.readFileSync(filePath)
    // Every 100 bytes should end in '\n' (no partial line at start).
    expect(buf[99]).toBe(0x0a)
    expect(buf.length % 100).toBe(0)
    await archive.closeStream(STABLE_ID)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('delete removes archive file + empty taskdir', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    archive.append(STABLE_ID, 'data\n')
    await archive.delete(STABLE_ID)
    const filePath = path.join(dir, TASK_ID, `${TAB_ID}.log`)
    expect(fs.existsSync(filePath)).toBe(false)
    expect(fs.existsSync(path.join(dir, TASK_ID))).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('deleteTask removes whole task subtree', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    archive.append(`${TASK_ID}:tab1`, 'a\n')
    archive.append(`${TASK_ID}:tab2`, 'b\n')
    await archive.deleteTask(TASK_ID)
    expect(fs.existsSync(path.join(dir, TASK_ID))).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('rejects unsafe stable ids', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    archive.append('../etc:passwd', 'pwned\n')
    archive.append(':no-task-id', 'oops\n')
    archive.append('only-one-side:', 'oops\n')
    archive.append('with/slash:tab', 'oops\n')
    // None of the above should have created files.
    const entries = fs.readdirSync(dir)
    expect(entries.length).toBe(0)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('sweepOrphans deletes archives whose task is not live', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    archive.append(`${TASK_ID}:tab1`, 'a\n')
    archive.append('orphantask:tab1', 'b\n')
    await archive.closeStream(`${TASK_ID}:tab1`)
    await archive.closeStream('orphantask:tab1')
    await archive.sweepOrphans(
      (taskId) => taskId === TASK_ID,
      () => true,
    )
    expect(fs.existsSync(path.join(dir, TASK_ID))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'orphantask'))).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await test('sweepOrphans deletes individual tab archives whose tab is not live', async () => {
    const dir = makeTmpDir()
    const archive = new ScrollbackArchive(dir)
    archive.append(`${TASK_ID}:livetab`, 'a\n')
    archive.append(`${TASK_ID}:deadtab`, 'b\n')
    await archive.closeStream(`${TASK_ID}:livetab`)
    await archive.closeStream(`${TASK_ID}:deadtab`)
    await archive.sweepOrphans(
      () => true,
      (_taskId, tabId) => tabId === 'livetab',
    )
    expect(fs.existsSync(path.join(dir, TASK_ID, 'livetab.log'))).toBe(true)
    expect(fs.existsSync(path.join(dir, TASK_ID, 'deadtab.log'))).toBe(false)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run()
