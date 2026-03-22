/**
 * Tab label resolution tests
 * Run with: pnpm tsx packages/domains/task-terminals/src/client/get-tab-label.test.ts
 */
import { getTabLabel, numberDuplicateLabels } from './get-tab-label.js'
import type { TerminalTab } from '../shared/types.js'

function test(name: string, fn: () => void) { try { fn(); console.log(`  ✓ ${name}`) } catch (e) { console.error(`  ✗ ${name}`); throw e } }
function expect<T>(v: T) { return { toBe(e: T) { if (v !== e) throw new Error(`expected ${JSON.stringify(e)}, got ${JSON.stringify(v)}`) } } }

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return { id: '1', taskId: 't', groupId: 'g', label: null, mode: 'terminal', isMain: false, position: 0, createdAt: '', ...overrides }
}

console.log('getTabLabel')

// User-set label always wins
test('user-set label takes priority over processTitle', () => {
  expect(getTabLabel(makeTab({ label: 'My Build' }), 'node')).toBe('My Build')
})

test('user-set label takes priority on main tab', () => {
  expect(getTabLabel(makeTab({ isMain: true, mode: 'claude-code', label: 'Custom' }))).toBe('Custom')
})

// Main tab mode names
test('main tab shows mode name when no label', () => {
  expect(getTabLabel(makeTab({ isMain: true, mode: 'claude-code' }))).toBe('Claude Code')
})

test('main tab shows Codex for codex mode', () => {
  expect(getTabLabel(makeTab({ isMain: true, mode: 'codex' }))).toBe('Codex')
})

test('main tab shows Copilot for copilot mode', () => {
  expect(getTabLabel(makeTab({ isMain: true, mode: 'copilot' }))).toBe('Copilot')
})

test('main tab shows Terminal for terminal mode', () => {
  expect(getTabLabel(makeTab({ isMain: true, mode: 'terminal' }))).toBe('Terminal')
})

// Non-main tab: processTitle
test('non-main shows processTitle when no label', () => {
  expect(getTabLabel(makeTab(), 'node')).toBe('node')
})

test('non-main shows processTitle over default', () => {
  expect(getTabLabel(makeTab(), 'vim')).toBe('vim')
})

// Non-main tab: fallback to "Terminal"
test('non-main falls back to Terminal when no label or processTitle', () => {
  expect(getTabLabel(makeTab())).toBe('Terminal')
})

test('non-main falls back to Terminal when processTitle is empty', () => {
  expect(getTabLabel(makeTab(), '')).toBe('Terminal')
})

// Key regression: null label must not block processTitle
test('null label does not block processTitle (regression)', () => {
  expect(getTabLabel(makeTab({ label: null }), 'npm')).toBe('npm')
})

console.log('\nnumberDuplicateLabels')

test('single tab — no numbering', () => {
  const labels = new Map([['a', 'zsh']])
  const result = numberDuplicateLabels(labels)
  expect(result.get('a')!).toBe('zsh')
})

test('two tabs with same label — second gets (2)', () => {
  const labels = new Map([['a', 'zsh'], ['b', 'zsh']])
  const result = numberDuplicateLabels(labels)
  expect(result.get('a')!).toBe('zsh')
  expect(result.get('b')!).toBe('zsh (2)')
})

test('three tabs with same label — numbered (2) and (3)', () => {
  const labels = new Map([['a', 'Terminal'], ['b', 'Terminal'], ['c', 'Terminal']])
  const result = numberDuplicateLabels(labels)
  expect(result.get('a')!).toBe('Terminal')
  expect(result.get('b')!).toBe('Terminal (2)')
  expect(result.get('c')!).toBe('Terminal (3)')
})

test('mixed unique and duplicate — unique stays bare', () => {
  const labels = new Map([['a', 'zsh'], ['b', 'node'], ['c', 'zsh']])
  const result = numberDuplicateLabels(labels)
  expect(result.get('a')!).toBe('zsh')
  expect(result.get('b')!).toBe('node')
  expect(result.get('c')!).toBe('zsh (2)')
})

test('all unique — no numbering', () => {
  const labels = new Map([['a', 'zsh'], ['b', 'node'], ['c', 'vim']])
  const result = numberDuplicateLabels(labels)
  expect(result.get('a')!).toBe('zsh')
  expect(result.get('b')!).toBe('node')
  expect(result.get('c')!).toBe('vim')
})

console.log('\nDone')
