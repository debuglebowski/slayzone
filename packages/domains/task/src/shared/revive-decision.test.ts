import { decideReviveMode, COLD_RESPAWN_MS } from './types'

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

const NOW = 1_000_000_000_000

// RC2 regression (the bug): unknown kill time must RESUME, never go fresh.
// Defaulting null→fresh is what clobbered live conversations into phantoms.
assert(decideReviveMode(null, NOW) === 'resume', 'null killedAt must resume, never fresh')

// Hot bounce: recently killed → resume.
assert(decideReviveMode(NOW - 1000, NOW) === 'resume', 'recent kill resumes')
assert(
  decideReviveMode(NOW - (COLD_RESPAWN_MS - 1), NOW) === 'resume',
  'just under threshold resumes'
)

// Boundary: exactly at threshold → resume (strictly-greater goes fresh).
assert(decideReviveMode(NOW - COLD_RESPAWN_MS, NOW) === 'resume', 'exactly threshold resumes')

// Cold bounce: sat past the threshold → fresh.
assert(
  decideReviveMode(NOW - (COLD_RESPAWN_MS + 1), NOW) === 'fresh',
  'past threshold starts fresh'
)

console.log('revive-decision: all passed')
