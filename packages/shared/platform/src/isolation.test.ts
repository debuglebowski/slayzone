import { describe, expect, test, vi } from 'vitest'
import {
  classifyFault,
  createAsyncFaultLedger,
  faultAllowsRun,
  faultBackoffMs,
  forEachIsolated,
  forEachIsolatedSync,
  isStorageFatal,
  type FaultLedger,
  type ItemFaultRow,
  StructuralFaultError
} from './isolation'
import { UnsafePathError } from './safe-path'

const quiet = { log: () => {} }

/** In-memory ledger with the same semantics as the SQL one (pure gate + backoff). */
function memoryLedger() {
  const rows = new Map<string, ItemFaultRow>()
  const k = (pass: string, item: string) => `${pass}\u0000${item}`
  const ledger: FaultLedger = {
    allows: (pass, item, fp, now) => faultAllowsRun(rows.get(k(pass, item)), fp, now),
    record: (input, now) => {
      const prev = rows.get(k(input.pass, input.itemKey))
      const attempts = (prev?.attempts ?? 0) + 1
      rows.set(k(input.pass, input.itemKey), {
        origin: 'computer',
        computer_id: '',
        pass: input.pass,
        item_key: input.itemKey,
        task_id: input.taskId ?? null,
        kind: input.kind,
        fingerprint: input.fingerprint ?? null,
        message: input.error.message,
        attempts,
        first_at: prev?.first_at ?? now,
        last_at: now,
        next_retry_at:
          input.kind === 'structural' && input.fingerprint != null
            ? null
            : now + faultBackoffMs(attempts)
      })
    },
    clear: (pass, item) => void rows.delete(k(pass, item))
  }
  return { rows, ledger }
}

describe('forEachIsolated', () => {
  test('one bad item fails alone; the rest run', async () => {
    const seen: number[] = []
    const report = await forEachIsolated([1, 2, 3], { pass: 'p', key: String, ...quiet }, (n) => {
      if (n === 2) throw new Error('bad')
      seen.push(n)
    })
    expect(seen).toEqual([1, 3])
    expect(report.ok).toBe(2)
    expect(report.failed.map((f) => f.key)).toEqual(['2'])
  })

  test('a fatal error stops the pass', async () => {
    const seen: number[] = []
    const fatal = Object.assign(new Error('disk'), { code: 'ENOSPC' })
    await expect(
      forEachIsolated(
        [1, 2, 3],
        { pass: 'p', key: String, isFatal: isStorageFatal, ...quiet },
        (n) => {
          if (n === 2) throw fatal
          seen.push(n)
        }
      )
    ).rejects.toBe(fatal)
    expect(seen).toEqual([1])
  })

  test('transient faults back off; success clears the record', async () => {
    const { rows, ledger } = memoryLedger()
    let now = 1_000
    let fail = true
    const pass = () =>
      forEachIsolated(['a'], { pass: 'p', key: (s) => s, ledger, now: () => now, ...quiet }, () => {
        if (fail) throw new Error('busy')
      })
    expect((await pass()).failed).toHaveLength(1)
    expect(rows.get('p\u0000a')?.kind).toBe('transient')
    // Inside the backoff window: skipped.
    expect((await pass()).skipped).toEqual(['a'])
    now += faultBackoffMs(1)
    fail = false
    expect((await pass()).ok).toBe(1)
    expect(rows.size).toBe(0)
  })

  test('a structural fault is quarantined until the fingerprint changes', async () => {
    const { rows, ledger } = memoryLedger()
    let fp = 'v1'
    const runs: string[] = []
    const pass = () =>
      forEachIsolated(
        ['j'],
        { pass: 'p', key: (s) => s, fingerprint: () => fp, ledger, now: () => 0, ...quiet },
        () => {
          runs.push(fp)
          if (fp === 'v1') throw new SyntaxError('Unexpected token')
        }
      )
    await pass()
    expect(rows.get('p\u0000j')).toMatchObject({ kind: 'structural', next_retry_at: null })
    await pass() // unchanged → not retried even though "time" never moved
    expect(runs).toEqual(['v1'])
    fp = 'v2'
    await pass()
    expect(runs).toEqual(['v1', 'v2'])
    expect(rows.size).toBe(0)
  })

  test('ignoreGate runs a held-back item (explicit Retry)', async () => {
    const { ledger } = memoryLedger()
    const fails = () =>
      forEachIsolated(['x'], { pass: 'p', key: (s) => s, ledger, now: () => 0, ...quiet }, () => {
        throw new Error('no')
      })
    await fails()
    const run = vi.fn()
    await forEachIsolated(
      ['x'],
      { pass: 'p', key: (s) => s, ledger, now: () => 0, ignoreGate: true, ...quiet },
      run
    )
    expect(run).toHaveBeenCalledOnce()
  })

  test('sync variant isolates the same way', () => {
    const seen: string[] = []
    const report = forEachIsolatedSync(
      ['a', 'b', 'c'],
      { pass: 'p', key: (s) => s, ...quiet },
      (s) => {
        if (s === 'a') throw new Error('x')
        seen.push(s)
      }
    )
    expect(seen).toEqual(['b', 'c'])
    expect(report.failed).toHaveLength(1)
  })
})

describe('classifyFault / isStorageFatal', () => {
  test('parse, schema and unsafe-path errors are structural', () => {
    expect(classifyFault(new SyntaxError('x'))).toBe('structural')
    expect(classifyFault(Object.assign(new Error('x'), { name: 'ZodError' }))).toBe('structural')
    expect(classifyFault(new UnsafePathError('INVALID_ID', 'x'))).toBe('structural')
    expect(classifyFault(new StructuralFaultError('x'))).toBe('structural')
    expect(classifyFault(new Error('EBUSY'))).toBe('transient')
  })

  test('disk and database breakage is fatal', () => {
    expect(isStorageFatal(Object.assign(new Error(), { code: 'SQLITE_CORRUPT' }))).toBe(true)
    expect(isStorageFatal(Object.assign(new Error(), { code: 'SQLITE_IOERR_WRITE' }))).toBe(true)
    expect(isStorageFatal(Object.assign(new Error(), { code: 'ENOENT' }))).toBe(false)
  })
})

describe('createAsyncFaultLedger', () => {
  test('drops a fault the erasure fence refuses (task gone)', async () => {
    const db = {
      get: async () => undefined,
      run: async () => {
        throw new Error('Content was permanently erased')
      }
    }
    const ledger = createAsyncFaultLedger(db, { origin: 'hub', computerId: 'pc' })
    await expect(
      ledger.record(
        { pass: 'p', itemKey: 'k', taskId: 't', kind: 'transient', error: new Error('x') },
        0
      )
    ).resolves.toBeUndefined()
  })
})
