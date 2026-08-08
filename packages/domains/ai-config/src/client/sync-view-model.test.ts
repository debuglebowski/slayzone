/**
 * Context manager sync view-model tests
 * Run with: npx tsx packages/domains/ai-config/src/client/sync-view-model.test.ts
 */
import {
  aggregateProviderSyncHealth,
  canShowProviderPull,
  canShowProviderPush,
  groupProvidersByPath,
  hasPendingProviderSync,
  toSyncBadgeLabel,
  type ProviderGroupEntry,
  type ProviderSyncEntry
} from './sync-view-model'
import type { CliProvider } from '../shared'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
    passed += 1
  } catch (error) {
    console.log(`✗ ${name}`)
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
    failed += 1
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected)
        throw new Error(`Expected ${String(actual)} to be ${String(expected)}`)
    }
  }
}

const linkedSynced: ProviderSyncEntry = { syncHealth: 'synced', syncReason: null }
const linkedStale: ProviderSyncEntry = { syncHealth: 'stale', syncReason: 'external_edit' }
const unlinkedMissing: ProviderSyncEntry = { syncHealth: 'not_synced', syncReason: 'not_linked' }
const unlinkedUnmanaged: ProviderSyncEntry = { syncHealth: 'unmanaged', syncReason: 'not_linked' }

test('aggregateProviderSyncHealth prefers stale over other linked states', () => {
  expect(
    aggregateProviderSyncHealth({
      claude: linkedSynced,
      codex: linkedStale
    })
  ).toBe('stale')
})

test('aggregateProviderSyncHealth ignores unlinked not_synced entries', () => {
  expect(
    aggregateProviderSyncHealth({
      claude: linkedSynced,
      codex: unlinkedMissing
    })
  ).toBe('synced')
})

test('aggregateProviderSyncHealth surfaces unmanaged when present', () => {
  expect(
    aggregateProviderSyncHealth({
      codex: linkedSynced,
      claude: unlinkedUnmanaged
    })
  ).toBe('unmanaged')
})

test('aggregateProviderSyncHealth falls back to not_synced when only unlinked missing files exist', () => {
  expect(
    aggregateProviderSyncHealth({
      claude: unlinkedMissing,
      codex: unlinkedMissing
    })
  ).toBe('not_synced')
})

test('toSyncBadgeLabel maps every sync health to stable text', () => {
  expect(toSyncBadgeLabel('synced')).toBe('Synced')
  expect(toSyncBadgeLabel('stale')).toBe('Stale')
  expect(toSyncBadgeLabel('unmanaged')).toBe('Unmanaged')
  expect(toSyncBadgeLabel('not_synced')).toBe('Not synced')
})

test('canShowProviderPush hides push for synced rows unless actively pushing', () => {
  expect(canShowProviderPush({ syncHealth: 'synced', canPush: true, isPushing: false })).toBe(false)
  expect(canShowProviderPush({ syncHealth: 'synced', canPush: true, isPushing: true })).toBe(true)
})

test('canShowProviderPush respects write capability', () => {
  expect(canShowProviderPush({ syncHealth: 'stale', canPush: false, isPushing: false })).toBe(false)
  expect(canShowProviderPush({ syncHealth: 'stale', canPush: true, isPushing: false })).toBe(true)
})

test('canShowProviderPull only shows for stale rows', () => {
  expect(canShowProviderPull('stale')).toBe(true)
  expect(canShowProviderPull('synced')).toBe(false)
  expect(canShowProviderPull('unmanaged')).toBe(false)
  expect(canShowProviderPull('not_synced')).toBe(false)
})

test('hasPendingProviderSync returns true when any provider is not synced', () => {
  expect(hasPendingProviderSync(['synced', 'synced'])).toBe(false)
  expect(hasPendingProviderSync(['synced', 'stale'])).toBe(true)
  expect(hasPendingProviderSync(['not_synced'])).toBe(true)
})

const ROW_ORDER: CliProvider[] = [
  'claude',
  'codex',
  'cursor',
  'gemini',
  'opencode',
  'qwen',
  'copilot'
]

const claudeStale: ProviderGroupEntry = {
  path: '.claude/skills/foo/SKILL.md',
  syncHealth: 'stale',
  syncReason: 'external_edit',
  diskContent: 'CLAUDE-DISK'
}
const codexStaleAgents: ProviderGroupEntry = {
  path: '.agents/skills/foo/SKILL.md',
  syncHealth: 'stale',
  syncReason: 'external_edit',
  diskContent: 'AGENTS-DISK'
}
const geminiStaleAgents: ProviderGroupEntry = {
  path: '.agents/skills/foo/SKILL.md',
  syncHealth: 'stale',
  syncReason: 'external_edit',
  diskContent: 'AGENTS-DISK'
}
const cursorSynced: ProviderGroupEntry = {
  path: '.cursor/skills/foo/SKILL.md',
  syncHealth: 'synced',
  syncReason: null
}

test('groupProvidersByPath collapses codex + gemini sharing .agents/skills into one group', () => {
  const groups = groupProvidersByPath(
    { claude: claudeStale, codex: codexStaleAgents, gemini: geminiStaleAgents },
    ROW_ORDER
  )
  expect(groups.length).toBe(2)
  expect(groups[0].providers.join(',')).toBe('claude')
  expect(groups[0].path).toBe('.claude/skills/foo/SKILL.md')
  expect(groups[1].providers.join(',')).toBe('codex,gemini')
  expect(groups[1].path).toBe('.agents/skills/foo/SKILL.md')
  expect(groups[1].diskContent).toBe('AGENTS-DISK')
})

test('groupProvidersByPath preserves registry order across groups', () => {
  const groups = groupProvidersByPath(
    { gemini: geminiStaleAgents, codex: codexStaleAgents, claude: claudeStale },
    ROW_ORDER
  )
  expect(groups[0].providers[0]).toBe('claude')
  expect(groups[1].providers[0]).toBe('codex')
  expect(groups[1].providers[1]).toBe('gemini')
})

test('groupProvidersByPath filters out unlinked not_synced entries', () => {
  const groups = groupProvidersByPath(
    { claude: claudeStale, codex: { ...unlinkedMissing, path: '.agents/skills/foo/SKILL.md' } },
    ROW_ORDER
  )
  expect(groups.length).toBe(1)
  expect(groups[0].providers.join(',')).toBe('claude')
})

test('groupProvidersByPath returns single-provider row when path is unique', () => {
  const groups = groupProvidersByPath({ claude: claudeStale, cursor: cursorSynced }, ROW_ORDER)
  expect(groups.length).toBe(2)
  expect(groups[0].providers.join(',')).toBe('claude')
  expect(groups[1].providers.join(',')).toBe('cursor')
  expect(groups[1].syncHealth).toBe('synced')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
