import { afterEach, expect, test } from 'vitest'
import {
  _resetHibernatedSessionIdsSource,
  listHibernatedSessionIds,
  registerHibernatedSessionIdsSource
} from './hibernated-sessions-source'

afterEach(() => _resetHibernatedSessionIdsSource())

test('reads through the registered source', async () => {
  registerHibernatedSessionIdsSource(async () => ['t1:t1', 't2:t2'])
  await expect(listHibernatedSessionIds()).resolves.toEqual(['t1:t1', 't2:t2'])
})

test('rejects (does not throw) before any registration', async () => {
  await expect(listHibernatedSessionIds()).rejects.toThrow(/registerHibernatedSessionIdsSource/)
})

test('re-registering the same source is a no-op; a different one throws', () => {
  const source = async (): Promise<string[]> => []
  registerHibernatedSessionIdsSource(source)
  expect(() => registerHibernatedSessionIdsSource(source)).not.toThrow()
  expect(() => registerHibernatedSessionIdsSource(async () => [])).toThrow(/already registered/)
})
