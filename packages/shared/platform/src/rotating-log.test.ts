import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createRotatingFileLog } from './rotating-log'

const text = (f: string): string => (existsSync(f) ? readFileSync(f, 'utf8') : '')
const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
}

it('rotates while running (the hub rotated sidecar.log only at boot), losing no line', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rotating-log-')), 'logs', 'sidecar.log')
  const log = createRotatingFileLog(file, { maxBytes: 1000 })
  for (let i = 0; i < 20; i++) {
    log(`line ${i} ${'x'.repeat(40)}`)
    await new Promise((r) => setTimeout(r, 2))
  }
  log('newest')
  await until(() => text(file).includes('newest') && text(`${file}.1`).length > 0)
  expect(statSync(file).size).toBeLessThanOrEqual(1000 + 120)
  const both = text(`${file}.1`) + text(file)
  for (let i = 0; i < 20; i++) expect(both).toContain(`line ${i} `)
  expect(text(file)).toMatch(/^\d{4}-\d\d-\d\dT\S+ /)
})

it('an unusable path gives a no-op, never a throw', () => {
  const blocker = join(mkdtempSync(join(tmpdir(), 'rotating-log-')), 'f')
  writeFileSync(blocker, '')
  const nested = createRotatingFileLog(join(blocker, 'logs', 'x.log'))
  expect(() => nested('b')).not.toThrow()
})

it('several writers on one file: bounded size, and no writer rotates away the older generation', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'rotating-log-')), 'computer.log')
  const writers = ['supervisor', 'worker', 'host'].map(() =>
    createRotatingFileLog(file, { maxBytes: 2000 })
  )
  // Interleaved, as the supervisor, worker and session host write computer.log.
  for (let i = 0; i < 60; i++) {
    writers[i % 3](`w${i % 3} line ${i} ${'x'.repeat(40)}`)
    await new Promise((r) => setTimeout(r, 2))
  }
  writers[0]('newest')
  await until(() => text(file).includes('newest'))
  await new Promise((r) => setTimeout(r, 50))
  // Each writer counting only its own bytes let the file reach ~3× the limit.
  expect(statSync(file).size).toBeLessThanOrEqual(2000 + 120)
  // The newest lines are all in the live file or the one generation kept, in order:
  // a writer that rotated a file another had just started would drop a whole block.
  const both = text(`${file}.1`) + text(file)
  const kept = [...both.matchAll(/ line (\d+) /g)].map((m) => Number(m[1]))
  expect(kept.length).toBeGreaterThan(0)
  const last = kept[kept.length - 1]
  for (let i = kept[0]; i <= last; i++) expect(kept).toContain(i)
  expect(last).toBe(59)
})
