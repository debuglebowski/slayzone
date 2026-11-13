import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  discardQuarantine,
  eraseQuarantinedForTask,
  listQuarantine,
  quarantineMove,
  readJsonArraySalvage,
  readJsonTolerant,
  restoreQuarantine,
  scanJsonArrayElements
} from './quarantine'

const root = () => mkdtempSync(join(tmpdir(), 'slz-quarantine-'))
const asObject = (v: unknown) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
  return v as Record<string, unknown>
}

describe('scanJsonArrayElements', () => {
  test('a well-formed array is complete', () => {
    expect(scanJsonArrayElements('[{"a":"],"},[1,2], "x" ]')).toEqual({
      elements: ['{"a":"],"}', '[1,2]', '"x"'],
      complete: true
    })
    expect(scanJsonArrayElements(' [] ')).toEqual({ elements: [], complete: true })
  })
  test('a torn tail keeps the readable prefix', () => {
    expect(scanJsonArrayElements('[{"id":1},{"id":2},{"id":')).toEqual({
      elements: ['{"id":1}', '{"id":2}'],
      complete: false
    })
    expect(scanJsonArrayElements('garbage').complete).toBe(false)
  })
})

describe('readJsonTolerant', () => {
  test('missing, ok, corrupt (quarantined, original path freed)', () => {
    const r = root()
    const file = join(r, 'generations.json')
    const q = { root: r, pass: 'computer.generations' }
    expect(readJsonTolerant(file, asObject, q)).toEqual({ status: 'missing' })
    writeFileSync(file, '{"a":1}')
    expect(readJsonTolerant(file, asObject, q)).toEqual({ status: 'ok', value: { a: 1 } })
    writeFileSync(file, '{"a":')
    const bad = readJsonTolerant(file, asObject, q)
    expect(bad.status).toBe('corrupt')
    expect(existsSync(file)).toBe(false)
    const [entry] = listQuarantine(r)
    expect(entry.meta?.originalPath).toBe(file)
    expect(readFileSync(entry.payloadPath, 'utf8')).toBe('{"a":')
    // Retry puts it back; Discard deletes.
    expect(restoreQuarantine(r, entry.pass, entry.id)).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('{"a":')
  })

  test('schema rejection is corrupt too', () => {
    const r = root()
    const file = join(r, 'x.json')
    writeFileSync(file, '[1]')
    expect(readJsonTolerant(file, asObject, { root: r, pass: 'p' }).status).toBe('corrupt')
  })
})

describe('readJsonArraySalvage', () => {
  test('keeps readable entries, quarantines the original bytes', () => {
    const r = root()
    const file = join(r, 'hooks.json')
    const text = '[{"id":"a","task":"t1"},7,{"id":"b","task":"t2"},{"id":"c'
    writeFileSync(file, text)
    const res = readJsonArraySalvage(file, asObject, { root: r, pass: 'computer.hook-journal' })
    expect(res.status).toBe('salvaged')
    expect(res.items.map((i) => i.id)).toEqual(['a', 'b'])
    const [entry] = listQuarantine(r)
    expect(readFileSync(entry.payloadPath, 'utf8')).toBe(text)
  })

  test('a clean journal is not quarantined', () => {
    const r = root()
    const file = join(r, 'hooks.json')
    writeFileSync(file, '[{"id":"a"}]')
    expect(readJsonArraySalvage(file, asObject, { root: r, pass: 'p' }).status).toBe('ok')
    expect(listQuarantine(r)).toEqual([])
  })
})

describe('erasure and discard', () => {
  test('erases entries naming the task, by meta or by raw bytes', () => {
    const r = root()
    const a = join(r, 'a.json')
    writeFileSync(a, 'junk mentioning task-123 somewhere')
    quarantineMove(r, { pass: 'p', path: a, reason: 'x' })
    const dir = join(r, 'txn')
    mkdirSync(dir)
    writeFileSync(join(dir, 'manifest.json'), '{')
    quarantineMove(r, { pass: 'p', path: dir, taskId: 'task-123', reason: 'x' })
    const other = join(r, 'b.json')
    writeFileSync(other, 'other')
    quarantineMove(r, { pass: 'p', path: other, reason: 'x' })
    expect(eraseQuarantinedForTask(r, 'task-123')).toBe(2)
    const left = listQuarantine(r)
    expect(left).toHaveLength(1)
    expect(discardQuarantine(r, left[0].pass, left[0].id)).toBe(true)
    expect(listQuarantine(r)).toEqual([])
  })
})
