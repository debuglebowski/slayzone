/**
 * Tests for migrateStateDir (core of migrateXdgIfNeeded)
 * Run: npx tsx packages/shared/platform/src/migrations.test.ts
 */
import fs from 'fs'
import path from 'path'
import os from 'os'
import { migrateStateDir, copyVerifyDelete } from './migrations'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`✗ ${name}`)
    console.error(`  ${e}`)
    failed++
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-migrate-test-'))
}

function cleanup(...dirs: string[]) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true }) } catch {}
  }
}

// --- No-op cases ---

test('no-op when oldDir === newDir', () => {
  const dir = tmpDir()
  try {
    const result = migrateStateDir(dir, dir)
    expect(result.migrated).toBe(false)
    expect(result.failed).toBe(false)
  } finally {
    cleanup(dir)
  }
})

test('no-op when newDir already exists', () => {
  const oldDir = tmpDir()
  const newDir = tmpDir()
  try {
    fs.writeFileSync(path.join(oldDir, 'slayzone.sqlite'), 'old-data')
    const result = migrateStateDir(oldDir, newDir)
    expect(result.migrated).toBe(false)
    expect(result.failed).toBe(false)
    // Old dir untouched
    expect(fs.existsSync(path.join(oldDir, 'slayzone.sqlite'))).toBe(true)
  } finally {
    cleanup(oldDir, newDir)
  }
})

test('no-op when oldDir does not exist (fresh install)', () => {
  const root = tmpDir()
  const oldDir = path.join(root, 'nonexistent')
  const newDir = path.join(root, 'new')
  try {
    const result = migrateStateDir(oldDir, newDir)
    expect(result.migrated).toBe(false)
    expect(result.failed).toBe(false)
    expect(fs.existsSync(newDir)).toBe(false)
  } finally {
    cleanup(root)
  }
})

// --- Happy path ---

test('migrates oldDir to newDir via rename', () => {
  const root = tmpDir()
  const oldDir = path.join(root, 'old')
  const newDir = path.join(root, 'new')
  fs.mkdirSync(oldDir)
  fs.writeFileSync(path.join(oldDir, 'slayzone.sqlite'), 'db-content')
  fs.writeFileSync(path.join(oldDir, 'slayzone.dev.sqlite'), 'dev-content')
  fs.writeFileSync(path.join(oldDir, 'other.txt'), 'other')
  try {
    const result = migrateStateDir(oldDir, newDir)
    expect(result.migrated).toBe(true)
    expect(result.failed).toBe(false)
    expect(result.newDir).toBe(newDir)
    // Old dir gone
    expect(fs.existsSync(oldDir)).toBe(false)
    // All files in new dir
    expect(fs.readFileSync(path.join(newDir, 'slayzone.sqlite'), 'utf8')).toBe('db-content')
    expect(fs.readFileSync(path.join(newDir, 'slayzone.dev.sqlite'), 'utf8')).toBe('dev-content')
    expect(fs.readFileSync(path.join(newDir, 'other.txt'), 'utf8')).toBe('other')
  } finally {
    cleanup(root)
  }
})

test('creates parent dirs for newDir', () => {
  const root = tmpDir()
  const oldDir = path.join(root, 'old')
  const newDir = path.join(root, 'deep', 'nested', 'new')
  fs.mkdirSync(oldDir)
  fs.writeFileSync(path.join(oldDir, 'slayzone.sqlite'), 'data')
  try {
    const result = migrateStateDir(oldDir, newDir)
    expect(result.migrated).toBe(true)
    expect(fs.readFileSync(path.join(newDir, 'slayzone.sqlite'), 'utf8')).toBe('data')
  } finally {
    cleanup(root)
  }
})

test('migrates even when no DB files exist (config-only dir)', () => {
  const root = tmpDir()
  const oldDir = path.join(root, 'old')
  const newDir = path.join(root, 'new')
  fs.mkdirSync(oldDir)
  fs.writeFileSync(path.join(oldDir, 'settings.json'), '{}')
  try {
    const result = migrateStateDir(oldDir, newDir)
    expect(result.migrated).toBe(true)
    expect(fs.existsSync(path.join(newDir, 'settings.json'))).toBe(true)
  } finally {
    cleanup(root)
  }
})

// --- Failure / rollback ---

test('fails and rolls back when newDir parent is not writable', () => {
  if (process.getuid?.() === 0) {
    console.log('  (skipped — running as root)')
    return
  }
  const root = tmpDir()
  const oldDir = path.join(root, 'old')
  const lockedParent = path.join(root, 'locked')
  const newDir = path.join(lockedParent, 'new')
  fs.mkdirSync(oldDir)
  fs.writeFileSync(path.join(oldDir, 'slayzone.sqlite'), 'important')
  // Create parent then remove write permission
  fs.mkdirSync(lockedParent)
  fs.chmodSync(lockedParent, 0o555)
  try {
    const result = migrateStateDir(oldDir, newDir)
    expect(result.migrated).toBe(false)
    expect(result.failed).toBe(true)
    // Old dir preserved
    expect(fs.readFileSync(path.join(oldDir, 'slayzone.sqlite'), 'utf8')).toBe('important')
  } finally {
    fs.chmodSync(lockedParent, 0o755)
    cleanup(root)
  }
})

// --- copyVerifyDelete (cross-device path) ---

test('copyVerifyDelete copies files, verifies, and removes old dir', () => {
  const root = tmpDir()
  const oldDir = path.join(root, 'old')
  const newDir = path.join(root, 'new')
  fs.mkdirSync(oldDir)
  fs.writeFileSync(path.join(oldDir, 'slayzone.sqlite'), 'db')
  fs.writeFileSync(path.join(oldDir, 'slayzone.dev.sqlite'), 'dev')
  fs.writeFileSync(path.join(oldDir, 'extra.txt'), 'extra')
  try {
    copyVerifyDelete(oldDir, newDir, ['slayzone.sqlite', 'slayzone.dev.sqlite'])
    expect(fs.existsSync(oldDir)).toBe(false)
    expect(fs.readFileSync(path.join(newDir, 'slayzone.sqlite'), 'utf8')).toBe('db')
    expect(fs.readFileSync(path.join(newDir, 'slayzone.dev.sqlite'), 'utf8')).toBe('dev')
    expect(fs.readFileSync(path.join(newDir, 'extra.txt'), 'utf8')).toBe('extra')
  } finally {
    cleanup(root)
  }
})

test('copyVerifyDelete passes with no expected files', () => {
  const root = tmpDir()
  const oldDir = path.join(root, 'old')
  const newDir = path.join(root, 'new')
  fs.mkdirSync(oldDir)
  fs.writeFileSync(path.join(oldDir, 'config.json'), '{}')
  try {
    copyVerifyDelete(oldDir, newDir, [])
    expect(fs.existsSync(oldDir)).toBe(false)
    expect(fs.existsSync(path.join(newDir, 'config.json'))).toBe(true)
  } finally {
    cleanup(root)
  }
})

test('copyVerifyDelete throws if expected file missing after copy', () => {
  const root = tmpDir()
  const oldDir = path.join(root, 'old')
  const newDir = path.join(root, 'new')
  fs.mkdirSync(oldDir)
  // Claim slayzone.sqlite should exist but don't create it
  try {
    let threw = false
    try {
      copyVerifyDelete(oldDir, newDir, ['slayzone.sqlite'])
    } catch (e) {
      threw = true
      expect(e instanceof Error).toBe(true)
      expect((e as Error).message.includes('Verification failed')).toBe(true)
    }
    expect(threw).toBe(true)
    // Old dir still exists (delete happens after verify)
    expect(fs.existsSync(oldDir)).toBe(true)
  } finally {
    cleanup(root)
  }
})

test('copyVerifyDelete preserves subdirectories', () => {
  const root = tmpDir()
  const oldDir = path.join(root, 'old')
  const newDir = path.join(root, 'new')
  fs.mkdirSync(oldDir)
  fs.mkdirSync(path.join(oldDir, 'backups'))
  fs.writeFileSync(path.join(oldDir, 'slayzone.sqlite'), 'db')
  fs.writeFileSync(path.join(oldDir, 'backups', 'backup-1.sqlite'), 'bak')
  try {
    copyVerifyDelete(oldDir, newDir, ['slayzone.sqlite'])
    expect(fs.readFileSync(path.join(newDir, 'backups', 'backup-1.sqlite'), 'utf8')).toBe('bak')
  } finally {
    cleanup(root)
  }
})

// --- Summary ---

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
