// Unit tests for shortcut-definitions utilities
// Run: npx tsx packages/shared/ui/src/shortcut-definitions.test.ts

import { formatKeysForDisplay, toElectronAccelerator, matchesShortcut } from './shortcut-definitions'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (error) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${error instanceof Error ? error.message : error}`)
    failed++
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
  }
}

// --- formatKeysForDisplay ---

console.log('formatKeysForDisplay')

test('formats mod+n for display', () => {
  const result = formatKeysForDisplay('mod+n')
  // On macOS: '⌘ N', on other: 'Ctrl N'
  // We can't control navigator.platform in this test, so just check structure
  expect(result.includes('N')).toBe(true)
})

test('formats mod+shift+d', () => {
  const result = formatKeysForDisplay('mod+shift+d')
  expect(result.includes('D')).toBe(true)
})

test('formats escape', () => {
  const result = formatKeysForDisplay('escape')
  expect(result).toBe('Escape')
})

test('formats ctrl+tab', () => {
  const result = formatKeysForDisplay('ctrl+tab')
  expect(result.includes('Tab')).toBe(true)
})

test('formats single character key', () => {
  const result = formatKeysForDisplay('mod+,')
  expect(result.includes(',')).toBe(true)
})

// --- toElectronAccelerator ---

console.log('\ntoElectronAccelerator')

test('converts mod+n to CmdOrCtrl+N', () => {
  expect(toElectronAccelerator('mod+n')).toBe('CmdOrCtrl+N')
})

test('converts mod+shift+d to CmdOrCtrl+Shift+D', () => {
  expect(toElectronAccelerator('mod+shift+d')).toBe('CmdOrCtrl+Shift+D')
})

test('converts mod+shift+n to CmdOrCtrl+Shift+N', () => {
  expect(toElectronAccelerator('mod+shift+n')).toBe('CmdOrCtrl+Shift+N')
})

test('converts mod+, to CmdOrCtrl+,', () => {
  expect(toElectronAccelerator('mod+,')).toBe('CmdOrCtrl+,')
})

test('converts alt+shift+k to Alt+Shift+K', () => {
  expect(toElectronAccelerator('alt+shift+k')).toBe('Alt+Shift+K')
})

test('converts escape to Escape', () => {
  expect(toElectronAccelerator('escape')).toBe('Escape')
})

test('converts ctrl+tab to Ctrl+Tab', () => {
  expect(toElectronAccelerator('ctrl+tab')).toBe('Ctrl+Tab')
})

// --- matchesShortcut ---

console.log('\nmatchesShortcut')

function makeKeyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent
}

test('matches mod+k on macOS (metaKey)', () => {
  const e = makeKeyEvent({ key: 'k', metaKey: true })
  expect(matchesShortcut(e, 'mod+k')).toBe(true)
})

test('does not match mod+k without modifier', () => {
  const e = makeKeyEvent({ key: 'k' })
  expect(matchesShortcut(e, 'mod+k')).toBe(false)
})

test('matches mod+shift+d', () => {
  const e = makeKeyEvent({ key: 'd', metaKey: true, shiftKey: true })
  expect(matchesShortcut(e, 'mod+shift+d')).toBe(true)
})

test('does not match mod+shift+d without shift', () => {
  const e = makeKeyEvent({ key: 'd', metaKey: true })
  expect(matchesShortcut(e, 'mod+shift+d')).toBe(false)
})

test('does not match mod+shift+d with wrong key', () => {
  const e = makeKeyEvent({ key: 'e', metaKey: true, shiftKey: true })
  expect(matchesShortcut(e, 'mod+shift+d')).toBe(false)
})

test('matches escape without modifiers', () => {
  const e = makeKeyEvent({ key: 'Escape' })
  expect(matchesShortcut(e, 'escape')).toBe(true)
})

test('does not match escape when shift is held', () => {
  const e = makeKeyEvent({ key: 'Escape', shiftKey: true })
  expect(matchesShortcut(e, 'escape')).toBe(false)
})

test('key comparison is case-insensitive', () => {
  const e = makeKeyEvent({ key: 'K', metaKey: true })
  expect(matchesShortcut(e, 'mod+k')).toBe(true)
})

test('matches ctrl+tab with ctrlKey (for ctrl-prefixed shortcuts on macOS)', () => {
  const e = makeKeyEvent({ key: 'Tab', ctrlKey: true })
  expect(matchesShortcut(e, 'ctrl+tab')).toBe(true)
})

test('ctrl+tab does not match when metaKey is pressed instead of ctrlKey', () => {
  const e = makeKeyEvent({ key: 'Tab', metaKey: true })
  expect(matchesShortcut(e, 'ctrl+tab')).toBe(false)
})

test('does not match mod+k when extra modifiers are pressed', () => {
  const e = makeKeyEvent({ key: 'k', metaKey: true, shiftKey: true })
  expect(matchesShortcut(e, 'mod+k')).toBe(false)
})

// --- Summary ---

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
