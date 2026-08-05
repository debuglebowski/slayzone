/**
 * runner.config.json — loadRunnerConfigFile / save / update, plus the legacy
 * shared config.json fallback. Pure Node (real temp files, no native deps) →
 * runs under plain `npx tsx`.
 *
 * Run with: npx tsx packages/shared/platform/src/runner-config-file.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getRunnerConfigFilePath,
  loadRunnerConfigFile,
  saveRunnerConfigFile,
  updateRunnerConfigFile
} from './slayzone-config'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`)
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'slz-runnercfg-'))
}

console.log('\nrunner-config-file: loadRunnerConfigFile')
console.log('─'.repeat(40))

test('missing file ⇒ {} (no throw)', () => {
  const dir = tmp()
  try {
    const cfg = loadRunnerConfigFile(join(dir, 'nope.json'))
    assertEq(Object.keys(cfg).length, 0, 'empty config')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corrupt JSON ⇒ {} + warns to stderr (no throw)', () => {
  const dir = tmp()
  const p = join(dir, 'runner.config.json')
  writeFileSync(p, '{not valid json')
  const orig = process.stderr.write.bind(process.stderr)
  let warned = ''
  ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    warned += s
    return true
  }
  try {
    const cfg = loadRunnerConfigFile(p)
    assertEq(Object.keys(cfg).length, 0, 'empty config on corrupt')
    assert(/not valid JSON/.test(warned), 'warned about invalid JSON')
  } finally {
    ;(process.stderr as unknown as { write: typeof orig }).write = orig
    rmSync(dir, { recursive: true, force: true })
  }
})

test('non-object JSON (array) ⇒ {} + warns', () => {
  const dir = tmp()
  const p = join(dir, 'runner.config.json')
  writeFileSync(p, '[1,2,3]')
  const orig = process.stderr.write.bind(process.stderr)
  let warned = ''
  ;(process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    warned += s
    return true
  }
  try {
    const cfg = loadRunnerConfigFile(p)
    assertEq(Object.keys(cfg).length, 0, 'empty on array')
    assert(/not a JSON object/.test(warned), 'warned about non-object')
  } finally {
    ;(process.stderr as unknown as { write: typeof orig }).write = orig
    rmSync(dir, { recursive: true, force: true })
  }
})

test('valid config parses all known keys, drops wrong types', () => {
  const dir = tmp()
  const p = join(dir, 'runner.config.json')
  writeFileSync(
    p,
    JSON.stringify({
      joinToken: 'jt-1',
      runnerName: 'r1',
      hubUrl: 'wss://hub/runners',
      allowedRoots: ['/srv/a', '/srv/b'],
      pinnedCertSha256: 'a'.repeat(64),
      // wrong-typed / unknown → dropped
      joinToken2: 'nope',
      extra: { nested: 1 }
    })
  )
  const cfg = loadRunnerConfigFile(p)
  assertEq(cfg.joinToken, 'jt-1', 'joinToken')
  assertEq(cfg.runnerName, 'r1', 'runnerName')
  assertEq(cfg.hubUrl, 'wss://hub/runners', 'hubUrl')
  assertEq(JSON.stringify(cfg.allowedRoots), JSON.stringify(['/srv/a', '/srv/b']), 'allowedRoots')
  assertEq(cfg.pinnedCertSha256, 'a'.repeat(64), 'pinnedCertSha256')
  assert(!('extra' in cfg), 'unknown key dropped')
  rmSync(dir, { recursive: true, force: true })
})

test('wrong-typed values are dropped (empty joinToken/hubUrl, non-array allowedRoots)', () => {
  const dir = tmp()
  const p = join(dir, 'runner.config.json')
  writeFileSync(
    p,
    JSON.stringify({ joinToken: '', hubUrl: '', allowedRoots: 'not-an-array', pinnedCertSha256: 42 })
  )
  const cfg = loadRunnerConfigFile(p)
  assert(cfg.joinToken === undefined, 'empty joinToken dropped')
  assert(cfg.hubUrl === undefined, 'empty hubUrl dropped')
  assert(cfg.allowedRoots === undefined, 'non-array allowedRoots dropped')
  assert(cfg.pinnedCertSha256 === undefined, 'non-string pinnedCertSha256 dropped')
  rmSync(dir, { recursive: true, force: true })
})

test('allowedRoots filters out non-string / empty entries, keeps a non-empty result', () => {
  const dir = tmp()
  const p = join(dir, 'runner.config.json')
  writeFileSync(p, JSON.stringify({ allowedRoots: ['/ok', '', 42, '/also-ok'] }))
  const cfg = loadRunnerConfigFile(p)
  assertEq(JSON.stringify(cfg.allowedRoots), JSON.stringify(['/ok', '/also-ok']), 'filtered array')
  rmSync(dir, { recursive: true, force: true })
})

console.log('\nrunner-config-file: save / update round-trip')
console.log('─'.repeat(40))

test('save then load round-trips + file is 0600, dir 0700 (POSIX)', () => {
  const dir = tmp()
  const p = join(dir, 'sub', 'runner.config.json')
  saveRunnerConfigFile({ hubUrl: 'wss://a/runners', runnerName: 'r1' }, p)
  const back = loadRunnerConfigFile(p)
  assertEq(back.hubUrl, 'wss://a/runners', 'hubUrl round-trip')
  assertEq(back.runnerName, 'r1', 'runnerName round-trip')
  if (process.platform !== 'win32') {
    assertEq(statSync(p).mode & 0o777, 0o600, 'file mode 0600')
    assertEq(statSync(join(dir, 'sub')).mode & 0o777, 0o700, 'dir mode 0700')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('updateRunnerConfigFile merges over on-disk base (no clobber of other keys)', () => {
  const dir = tmp()
  const p = join(dir, 'runner.config.json')
  saveRunnerConfigFile({ hubUrl: 'wss://a/runners' }, p)
  const merged = updateRunnerConfigFile({ joinToken: 'jt-2' }, p)
  assertEq(merged.hubUrl, 'wss://a/runners', 'kept hubUrl')
  assertEq(merged.joinToken, 'jt-2', 'added joinToken')
  const onDisk = loadRunnerConfigFile(p)
  assertEq(onDisk.joinToken, 'jt-2', 'persisted')
  assertEq(onDisk.hubUrl, 'wss://a/runners', 'persisted hubUrl')
  rmSync(dir, { recursive: true, force: true })
})

test('update ignores undefined patch values (does not erase)', () => {
  const dir = tmp()
  const p = join(dir, 'runner.config.json')
  saveRunnerConfigFile({ hubUrl: 'wss://a/runners' }, p)
  const merged = updateRunnerConfigFile({ hubUrl: undefined, runnerName: 'r2' }, p)
  assertEq(merged.hubUrl, 'wss://a/runners', 'undefined did not erase hubUrl')
  assertEq(merged.runnerName, 'r2', 'added runnerName')
  rmSync(dir, { recursive: true, force: true })
})

console.log('\nrunner-config-file: SLAYZONE_ROOT honored')
console.log('─'.repeat(40))

test('getRunnerConfigFilePath resolves under SLAYZONE_ROOT', () => {
  const dir = tmp()
  const prev = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = dir
  try {
    assertEq(getRunnerConfigFilePath(), join(dir, 'runner.config.json'), 'path under root override')
    saveRunnerConfigFile({ runnerName: 'r1' })
    const raw = readFileSync(join(dir, 'runner.config.json'), 'utf8')
    assert(/r1/.test(raw), 'wrote to the overridden root dir')
    assertEq(loadRunnerConfigFile().runnerName, 'r1', 'default-path load reads the override')
  } finally {
    if (prev === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log('\nrunner-config-file: legacy shared config.json fallback')
console.log('─'.repeat(40))

test('runner.config.json absent, legacy config.json present ⇒ runner keys coerced from it', () => {
  const dir = tmp()
  const legacyPath = join(dir, 'config.json')
  writeFileSync(legacyPath, JSON.stringify({ joinToken: 'legacy-jt', hubUrl: 'wss://legacy/runners' }))
  const cfgPath = join(dir, 'runner.config.json')
  const cfg = loadRunnerConfigFile(cfgPath)
  assertEq(cfg.joinToken, 'legacy-jt', 'joinToken from legacy file')
  assertEq(cfg.hubUrl, 'wss://legacy/runners', 'hubUrl from legacy file')
  assert(!existsSync(cfgPath), 'never auto-upgrades — runner.config.json not created by a read')
  rmSync(dir, { recursive: true, force: true })
})

test('new file present takes priority over the legacy file even if both exist', () => {
  const dir = tmp()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ runnerName: 'from-legacy' }))
  const cfgPath = join(dir, 'runner.config.json')
  saveRunnerConfigFile({ runnerName: 'from-new' }, cfgPath)
  assertEq(loadRunnerConfigFile(cfgPath).runnerName, 'from-new', 'new file wins once it exists')
  rmSync(dir, { recursive: true, force: true })
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
