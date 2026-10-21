/**
 * project-icons-migration — COPY-ONLY move of `project-icons/` into the channel
 * hub root. Icons were left behind by storage-migration / channel-storage-
 * migration (explicit allow-lists), so migrated DB rows kept pointing into the
 * legacy dir. Own sentinel (NOT the `.storage-migrated.*` one) so users already
 * migrated by a beta still get their icons. Sources are strictly read-only.
 *
 * Pure Node (real temp dirs, no electron/native deps) → runs under plain `npx tsx`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureProjectIcons } from './project-icons-migration'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}

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

// --- copies from a legacy source, source untouched, sentinel written -----------
{
  const { hubRoot, src } = setup()
  const userData = src('userData')
  writeFileSync(join(userData, 'project-icons', 'p1.png'), 'PNG1')
  writeFileSync(join(userData, 'project-icons', 'p2.svg'), 'SVG2')

  ensureProjectIcons({ sources: [userData], hubRoot })

  check('icon copied', readFileSync(join(hubRoot, 'project-icons', 'p1.png'), 'utf8') === 'PNG1')
  check('second icon copied', readFileSync(join(hubRoot, 'project-icons', 'p2.svg'), 'utf8') === 'SVG2')
  check(
    'source PRESERVED (copy-only)',
    readFileSync(join(userData, 'project-icons', 'p1.png'), 'utf8') === 'PNG1' &&
      existsSync(join(userData, 'project-icons', 'p2.svg'))
  )
  check('sentinel written', existsSync(join(hubRoot, SENTINEL)))
}

// --- multiple sources: earlier (newer) source wins a collision, others merge ----
{
  const { hubRoot, src } = setup()
  const flat = src('flat-storage')
  const userData = src('userData')
  writeFileSync(join(flat, 'project-icons', 'p1.png'), 'NEWER')
  writeFileSync(join(userData, 'project-icons', 'p1.png'), 'OLDER')
  writeFileSync(join(userData, 'project-icons', 'p3.png'), 'ONLY-OLD')

  ensureProjectIcons({ sources: [flat, userData], hubRoot })

  check(
    'first source wins collision',
    readFileSync(join(hubRoot, 'project-icons', 'p1.png'), 'utf8') === 'NEWER'
  )
  check(
    'icon only in later source still crosses over',
    readFileSync(join(hubRoot, 'project-icons', 'p3.png'), 'utf8') === 'ONLY-OLD'
  )
}

// --- never clobbers an icon already in the hub root -----------------------------
{
  const { hubRoot, src } = setup()
  const userData = src('userData')
  mkdirSync(join(hubRoot, 'project-icons'), { recursive: true })
  writeFileSync(join(hubRoot, 'project-icons', 'p1.png'), 'CURRENT')
  writeFileSync(join(userData, 'project-icons', 'p1.png'), 'STALE')

  ensureProjectIcons({ sources: [userData], hubRoot })

  check(
    'existing hub icon untouched (dest wins)',
    readFileSync(join(hubRoot, 'project-icons', 'p1.png'), 'utf8') === 'CURRENT'
  )
}

// --- genuinely one-time ----------------------------------------------------------
{
  const { hubRoot, src } = setup()
  const userData = src('userData')
  writeFileSync(join(userData, 'project-icons', 'p1.png'), 'A')
  ensureProjectIcons({ sources: [userData], hubRoot })
  writeFileSync(join(userData, 'project-icons', 'later.png'), 'LATER')
  ensureProjectIcons({ sources: [userData], hubRoot })
  check('sentinel makes 2nd run a no-op', !existsSync(join(hubRoot, 'project-icons', 'later.png')))
}

// --- runs even when the main storage migration already finished -------------------
{
  const { hubRoot, src } = setup()
  const userData = src('userData')
  writeFileSync(join(hubRoot, '.storage-migrated.prod'), 'done')
  writeFileSync(join(hubRoot, '.channel-migrated'), 'done')
  writeFileSync(join(userData, 'project-icons', 'p1.png'), 'A')
  ensureProjectIcons({ sources: [userData], hubRoot })
  check(
    'beta-cohort: not gated by the older sentinels',
    existsSync(join(hubRoot, 'project-icons', 'p1.png'))
  )
}

// --- fresh install / no icons anywhere --------------------------------------------
{
  const { base, hubRoot } = setup()
  let threw = false
  try {
    ensureProjectIcons({ sources: [join(base, 'nope'), join(base, 'also-nope')], hubRoot })
  } catch {
    threw = true
  }
  check('missing sources do not throw', !threw)
  check('sentinel written when nothing to copy', existsSync(join(hubRoot, SENTINEL)))
}

// --- a failed copy is NON-FATAL (never blocks boot) and retried next boot ---------
{
  const { hubRoot, src } = setup()
  const userData = src('userData')
  writeFileSync(join(userData, 'project-icons', 'p1.png'), 'A')
  writeFileSync(join(hubRoot, 'project-icons'), 'I-AM-A-FILE') // dest dir cannot be created
  const origError = console.error
  console.error = () => {}
  let threw = false
  try {
    ensureProjectIcons({ sources: [userData], hubRoot })
  } catch {
    threw = true
  } finally {
    console.error = origError
  }
  check('copy failure does not throw', !threw)
  check('no sentinel after failure (retries next boot)', !existsSync(join(hubRoot, SENTINEL)))
  check('source intact after failure', existsSync(join(userData, 'project-icons', 'p1.png')))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
