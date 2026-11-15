import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStandaloneArtifacts } from './standalone'
import { decodeArtifactText } from './text-content'

describe('decodeArtifactText', () => {
  it('decodes UTF-8 exactly, BOM kept', () => {
    const bytes = Buffer.from('﻿héllo ✓\n', 'utf8')
    expect(decodeArtifactText(bytes)).toBe('﻿héllo ✓\n')
  })

  it('empty is text', () => {
    expect(decodeArtifactText(new Uint8Array())).toBe('')
  })

  it('a NUL byte means binary', () => {
    expect(decodeArtifactText(Buffer.from([0x68, 0x00, 0x69]))).toBeNull()
  })

  it('invalid UTF-8 means binary (a lossy decode would rewrite it on save)', () => {
    // Latin-1 "é": valid in that encoding, not UTF-8.
    expect(decodeArtifactText(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBeNull()
  })
})

describe('store.readArtifactText', () => {
  let dir = ''
  let raw: Database.Database
  let ctx: ReturnType<typeof createStandaloneArtifacts>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'artifact-text-'))
    raw = new Database(join(dir, 'chat.sqlite'))
    ctx = createStandaloneArtifacts(raw, dir)
  })
  afterEach(() => {
    raw.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const upload = (title: string, bytes: Buffer) =>
    ctx.store.uploadArtifactBlob(ctx.db, { taskId: 't', title, bytes })

  it('text: the content and its byte size', async () => {
    const a = await upload('notes.md', Buffer.from('# hé\n', 'utf8'))
    expect(await ctx.store.readArtifactText(ctx.db, a!.id)).toEqual({
      kind: 'text',
      content: '# hé\n',
      size: 6
    })
  })

  it('binary: never decoded', async () => {
    const a = await upload('blob.bin', Buffer.from([0, 255, 128, 10]))
    expect(await ctx.store.readArtifactText(ctx.db, a!.id)).toEqual({ kind: 'binary', size: 4 })
  })

  it('over the cap: not read', async () => {
    const a = await upload('big.log', Buffer.from('0123456789', 'utf8'))
    expect(await ctx.store.readArtifactText(ctx.db, a!.id, 9)).toEqual({
      kind: 'too-large',
      size: 10
    })
    expect((await ctx.store.readArtifactText(ctx.db, a!.id, 10))?.kind).toBe('text')
  })

  it('reads the working file, as edited on disk', async () => {
    const a = await upload('notes.md', Buffer.from('v1', 'utf8'))
    const path = (await ctx.store.getArtifactPath(ctx.db, a!.id))!
    writeFileSync(path, Buffer.from([0x00, 0x01]))
    expect(await ctx.store.readArtifactText(ctx.db, a!.id)).toEqual({ kind: 'binary', size: 2 })
  })

  it("no working file: the current version's blob", async () => {
    const a = await upload('blob.bin', Buffer.from([0, 1, 2]))
    rmSync((await ctx.store.getArtifactPath(ctx.db, a!.id))!)
    expect(await ctx.store.readArtifactText(ctx.db, a!.id)).toEqual({ kind: 'binary', size: 3 })
  })

  it('unknown artifact: null', async () => {
    expect(await ctx.store.readArtifactText(ctx.db, 'nope')).toBeNull()
  })
})
