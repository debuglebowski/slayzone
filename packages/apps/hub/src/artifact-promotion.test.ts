/**
 * Moving a computer-held artifact to the hub when it is shared (T-100,
 * artifact-promotion.ts): every version copied in order with its name and author,
 * the computer's original deleted only after a whole copy, grants carried over; a
 * read failure leaves everything as it was. The computer side is a stand-in store;
 * the hub side is the real artifact store on a fully migrated database.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/artifact-promotion.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { createArtifactStore, type ArtifactStore } from '@slayzone/task-artifacts/server'
import type { ArtifactVersion } from '@slayzone/task-artifacts/shared'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness.js'
import { createArtifactPromotion } from './artifact-promotion'

const h = await createTestHarness()
const db = h.slayDb
const sql = (s: string, ...p: unknown[]): void => void h.db.prepare(s).run(...p)
const dataRoot = mkdtempSync(join(tmpdir(), 'slz-promote-test-'))
const local = createArtifactStore(dataRoot)

sql(`INSERT INTO projects (id, name, color, owner_user_id) VALUES ('p', 'P', '#000', 'user-a')`)
sql(`INSERT INTO tasks (id, project_id, title) VALUES ('t', 'p', 'T'), ('tPriv', 'p', 'Private')`)
sql(`UPDATE tasks SET visibility = 'private', created_by_user_id = 'user-a' WHERE id = 'tPriv'`)
sql(`INSERT INTO chat_ownership (id, task_id, tab_id, mode, computer_id, epoch, state)
  VALUES ('conv', 't', 'artifact-store:x', 'claude-chat', 'pc', 1, 'active')`)

/** What the computer holds: one artifact's versions (oldest first). */
let held: { id: string; taskId: string; versions: { bytes: string; name: string | null }[] }[]
let failReads = false
const deleted: string[] = []

function seedHeld(id: string, taskId: string, versions: { bytes: string; name: string | null }[]) {
  sql(`INSERT INTO task_artifacts (id, task_id, title) VALUES (?, ?, 'notes.md')`, id, taskId)
  sql(`INSERT INTO chat_artifact_locations (artifact_id, conversation_id) VALUES (?, 'conv')`, id)
  held.push({ id, taskId, versions })
}

/** The hub's artifact API as the composition builds it: held ids go to the computer. */
const computerStore = (): ArtifactStore => {
  const find = (id: string) => held.find((a) => a.id === id)
  return new Proxy(local, {
    get(target, key, receiver) {
      if (key === 'openArtifactReader') return undefined
      if (key === 'listArtifactVersions')
        return async (_db: unknown, d: { artifactId: string }) =>
          find(d.artifactId)!.versions.map(
            (v, i) =>
              ({
                id: `v${i + 1}`,
                artifact_id: d.artifactId,
                version_num: i + 1,
                content_hash: 'h',
                size: v.bytes.length,
                name: v.name,
                author_type: 'agent',
                author_id: 'claude',
                created_at: '',
                parent_id: null
              }) satisfies ArtifactVersion
          )
      if (key === 'resolveArtifactVersion')
        return async (_db: unknown, d: { artifactId: string; versionRef: number }) => {
          if (failReads) throw new Error('computer away')
          return {
            version: {},
            blobPath: null,
            bytes: Buffer.from(find(d.artifactId)!.versions[d.versionRef - 1]!.bytes)
          }
        }
      if (key === 'deleteArtifact')
        return async (_db: unknown, id: string) => {
          if (!find(id)) return Reflect.get(target, key, receiver)(db, id)
          deleted.push(id)
          sql('DELETE FROM task_artifacts WHERE id = ?', id)
          held = held.filter((a) => a.id !== id)
          return true
        }
      return Reflect.get(target, key, receiver)
    }
  }) as ArtifactStore
}

const promotion = createArtifactPromotion({ db, store: computerStore, local, log: () => {} })

beforeEach(() => {
  held = []
  failReads = false
  deleted.length = 0
  sql('DELETE FROM chat_artifact_locations')
  sql('DELETE FROM artifact_grants')
})

afterAll(() => {
  h.cleanup()
  rmSync(dataRoot, { recursive: true, force: true })
})

describe('artifact promotion', () => {
  test('every version moves in order, with its name; the original goes; grants follow', async () => {
    seedHeld('aHeld', 't', [
      { bytes: 'one', name: 'first' },
      { bytes: 'two', name: null },
      { bytes: 'three', name: 'final' }
    ])
    sql(
      `INSERT INTO artifact_grants (artifact_id, user_id, role) VALUES ('aHeld', 'user-e', 'view')`
    )
    const id = await promotion.promote('aHeld')
    expect(id).not.toBe('aHeld')
    const versions = (await local.listArtifactVersions(db, { artifactId: id })).sort(
      (a, b) => a.version_num - b.version_num
    )
    expect(versions.map((v) => v.name)).toEqual(['first', null, 'final'])
    const contents: string[] = []
    for (const v of versions)
      contents.push(
        await local.readArtifactVersion(db, { artifactId: id, versionRef: v.version_num })
      )
    expect(contents).toEqual(['one', 'two', 'three'])
    expect(deleted).toEqual(['aHeld'])
    expect(h.db.prepare('SELECT artifact_id FROM artifact_grants').all()).toEqual([
      { artifact_id: id }
    ])
    // Already on the hub: itself, nothing moves.
    expect(await promotion.promote(id)).toBe(id)
  })

  test('a failed read moves nothing and deletes nothing', async () => {
    seedHeld('aAway', 't', [{ bytes: 'x', name: null }])
    failReads = true
    const before = h.db.prepare('SELECT count(*) AS n FROM task_artifacts').get()
    await expect(promotion.promote('aAway')).rejects.toThrow('computer away')
    expect(deleted).toEqual([])
    expect(h.db.prepare('SELECT count(*) AS n FROM task_artifacts').get()).toEqual(before)
  })

  test("a project's move skips its private tasks; a computer's retry finds what is shared", async () => {
    seedHeld('aShared', 't', [{ bytes: 's', name: null }])
    seedHeld('aPrivate', 'tPriv', [{ bytes: 'p', name: null }])
    // No member yet: nothing on `pc` is shared.
    expect(await promotion.promoteSharedOn('pc')).toEqual({ moved: 0, failed: 0 })
    expect(await promotion.promoteProject('p')).toEqual({ moved: 1, failed: 0 })
    expect(deleted).toEqual(['aShared'])
    // The private task's file is shared once its task has a grant.
    sql(`INSERT INTO task_grants (task_id, user_id, role) VALUES ('tPriv', 'user-d', 'view')`)
    expect(await promotion.promoteSharedOn('pc')).toEqual({ moved: 1, failed: 0 })
    expect(deleted).toEqual(['aShared', 'aPrivate'])
  })
})
