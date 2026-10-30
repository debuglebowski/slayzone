/**
 * The computer's own record of where it keeps each project (`computer.projects.json`).
 *
 * The hub delivers several folders in a row on connect, a user can pick one at the
 * same moment, and one computer process can serve several hubs — so writes overlap.
 * Every write is a read-modify-write of one shared file; unserialized, the last
 * writer silently drops the others' entries while the hub believes they landed.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createProjectPathStore } from './project-paths'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slz-project-paths-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const onDisk = async (): Promise<Record<string, Record<string, { path: string }>>> =>
  JSON.parse(await readFile(join(dir, 'computer.projects.json'), 'utf8'))

test('concurrent sets on one store all land, on disk and in memory', async () => {
  const store = await createProjectPathStore('hub-a:1', { baseDir: dir })
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.set(`p${i}`, `/work/p${i}`)))
  expect(store.list()).toHaveLength(20)
  expect(Object.keys((await onDisk())['hub-a:1'])).toHaveLength(20)
})

test('concurrent writes from stores for two hubs never drop each other', async () => {
  const a = await createProjectPathStore('hub-a:1', { baseDir: dir })
  const b = await createProjectPathStore('hub-b:2', { baseDir: dir })
  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => a.set(`a${i}`, `/a/${i}`)),
    ...Array.from({ length: 10 }, (_, i) => b.set(`b${i}`, `/b/${i}`)),
    a.forget('never-set')
  ])
  const file = await onDisk()
  expect(Object.keys(file['hub-a:1'])).toHaveLength(10)
  expect(Object.keys(file['hub-b:2'])).toHaveLength(10)
})

test('set then forget in flight together end with the later intent', async () => {
  const store = await createProjectPathStore('hub-a:1', { baseDir: dir })
  await Promise.all([store.set('p', '/x'), store.forget('p'), store.set('q', '/y')])
  expect(store.get('p')).toBeNull()
  expect(store.get('q')?.path).toBe('/y')
  expect((await onDisk())['hub-a:1']).toEqual({ q: expect.objectContaining({ path: '/y' }) })
})
