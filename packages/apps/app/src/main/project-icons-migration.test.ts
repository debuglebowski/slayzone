/**
 * project-icons-migration — COPY-ONLY move of `project-icons/` into the channel
 * hub root. Icons were left behind by storage-migration / channel-storage-
 * migration (explicit allow-lists), so migrated DB rows kept pointing into the
 * legacy dir. Own sentinel (NOT the `.storage-migrated.*` one) so users already
 * migrated by a beta still get their icons. Sources are strictly read-only.
 *
 * Pure Node (real temp dirs, no electron/native deps).
 */
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureProjectIcons } from './project-icons-migration'

function setup(): { base: string; hubRoot: string; src: (n: string) => string } {
  const base = mkdtempSync(join(tmpdir(), 'slz-icons-mig-'))
  const hubRoot = join(base, 'hub')
  mkdirSync(hubRoot, { recursive: true })
  const src = (n: string): string => {
    const d = join(base, n)
    mkdirSync(join(d, 'project-icons'), { recursive: true })
    return d
  }
  return { base, hubRoot, src }
}

const SENTINEL = '.project-icons-migrated'

const read = (p: string): string => readFileSync(p, 'utf8')

// --- copies from a legacy source, source untouched, sentinel written -----------
describe('copies from a legacy source, source untouched, sentinel written', () => {
  let hubRoot: string
  let userData: string
  beforeAll(() => {
    const s = setup()
    hubRoot = s.hubRoot
    userData = s.src('userData')
    writeFileSync(join(userData, 'project-icons', 'p1.png'), 'PNG1')
    writeFileSync(join(userData, 'project-icons', 'p2.svg'), 'SVG2')

    ensureProjectIcons({ sources: [userData], hubRoot })
  })

  test('icon copied', () => {
    expect(read(join(hubRoot, 'project-icons', 'p1.png'))).toBe('PNG1')
  })
  test('second icon copied', () => {
    expect(read(join(hubRoot, 'project-icons', 'p2.svg'))).toBe('SVG2')
  })
  test('source PRESERVED (copy-only)', () => {
    expect(read(join(userData, 'project-icons', 'p1.png'))).toBe('PNG1')
    expect(existsSync(join(userData, 'project-icons', 'p2.svg'))).toBe(true)
  })
  test('sentinel written', () => {
    expect(existsSync(join(hubRoot, SENTINEL))).toBe(true)
  })
})

// --- multiple sources: earlier (newer) source wins a collision, others merge ----
describe('multiple sources: earlier (newer) source wins a collision, others merge', () => {
  let hubRoot: string
  beforeAll(() => {
    const s = setup()
    hubRoot = s.hubRoot
    const flat = s.src('flat-storage')
    const userData = s.src('userData')
    writeFileSync(join(flat, 'project-icons', 'p1.png'), 'NEWER')
    writeFileSync(join(userData, 'project-icons', 'p1.png'), 'OLDER')
    writeFileSync(join(userData, 'project-icons', 'p3.png'), 'ONLY-OLD')

    ensureProjectIcons({ sources: [flat, userData], hubRoot })
  })

  test('first source wins collision', () => {
    expect(read(join(hubRoot, 'project-icons', 'p1.png'))).toBe('NEWER')
  })
  test('icon only in later source still crosses over', () => {
    expect(read(join(hubRoot, 'project-icons', 'p3.png'))).toBe('ONLY-OLD')
  })
})

// --- never clobbers an icon already in the hub root -----------------------------
test('existing hub icon untouched (dest wins)', () => {
  const { hubRoot, src } = setup()
  const userData = src('userData')
  mkdirSync(join(hubRoot, 'project-icons'), { recursive: true })
  writeFileSync(join(hubRoot, 'project-icons', 'p1.png'), 'CURRENT')
  writeFileSync(join(userData, 'project-icons', 'p1.png'), 'STALE')

  ensureProjectIcons({ sources: [userData], hubRoot })

  expect(read(join(hubRoot, 'project-icons', 'p1.png'))).toBe('CURRENT')
})

// --- genuinely one-time ----------------------------------------------------------
test('sentinel makes 2nd run a no-op', () => {
  const { hubRoot, src } = setup()
  const userData = src('userData')
  writeFileSync(join(userData, 'project-icons', 'p1.png'), 'A')
  ensureProjectIcons({ sources: [userData], hubRoot })
  writeFileSync(join(userData, 'project-icons', 'later.png'), 'LATER')
  ensureProjectIcons({ sources: [userData], hubRoot })
  expect(existsSync(join(hubRoot, 'project-icons', 'later.png'))).toBe(false)
})

// --- runs even when the main storage migration already finished -------------------
test('beta-cohort: not gated by the older sentinels', () => {
  const { hubRoot, src } = setup()
  const userData = src('userData')
  writeFileSync(join(hubRoot, '.storage-migrated.prod'), 'done')
  writeFileSync(join(hubRoot, '.channel-migrated'), 'done')
  writeFileSync(join(userData, 'project-icons', 'p1.png'), 'A')
  ensureProjectIcons({ sources: [userData], hubRoot })
  expect(existsSync(join(hubRoot, 'project-icons', 'p1.png'))).toBe(true)
})

// --- fresh install / no icons anywhere --------------------------------------------
describe('fresh install / no icons anywhere', () => {
  let hubRoot: string
  let thrown: unknown
  beforeAll(() => {
    const s = setup()
    hubRoot = s.hubRoot
    try {
      ensureProjectIcons({ sources: [join(s.base, 'nope'), join(s.base, 'also-nope')], hubRoot })
    } catch (err) {
      thrown = err ?? new Error('threw')
    }
  })
  test('missing sources do not throw', () => {
    expect(thrown).toBeUndefined()
  })
  test('sentinel written when nothing to copy', () => {
    expect(existsSync(join(hubRoot, SENTINEL))).toBe(true)
  })
})

// --- a failed copy is NON-FATAL (never blocks boot) and retried next boot ---------
describe('a failed copy is NON-FATAL (never blocks boot) and retried next boot', () => {
  let hubRoot: string
  let userData: string
  let thrown: unknown
  beforeAll(() => {
    const s = setup()
    hubRoot = s.hubRoot
    userData = s.src('userData')
    writeFileSync(join(userData, 'project-icons', 'p1.png'), 'A')
    writeFileSync(join(hubRoot, 'project-icons'), 'I-AM-A-FILE') // dest dir cannot be created
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      ensureProjectIcons({ sources: [userData], hubRoot })
    } catch (err) {
      thrown = err ?? new Error('threw')
    } finally {
      quiet.mockRestore()
    }
  })
  test('copy failure does not throw', () => {
    expect(thrown).toBeUndefined()
  })
  test('no sentinel after failure (retries next boot)', () => {
    expect(existsSync(join(hubRoot, SENTINEL))).toBe(false)
  })
  test('source intact after failure', () => {
    expect(existsSync(join(userData, 'project-icons', 'p1.png'))).toBe(true)
  })
})
