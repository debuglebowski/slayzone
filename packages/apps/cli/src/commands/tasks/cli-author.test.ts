/**
 * cliAuthor() author-context resolution. The CLI runs inside an agent's
 * terminal; SlayZone injects the agent identity as `SLAYZONE_AGENT_ID` (the
 * mode string, see terminal/mcp-env.ts). cliAuthor must read THAT var to tag
 * CLI-authored artifacts/comments as agent-authored — reading a never-set var
 * silently mislabels every agent action as `user`.
 *
 * Pure Node (no native deps) → runs under plain `npx tsx`.
 */
import { cliAuthor } from './cli-author'

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

const prevId = process.env.SLAYZONE_AGENT_ID
const prevMode = process.env.SLAYZONE_AGENT_MODE
try {
  // --- agent context: SLAYZONE_AGENT_ID is what SlayZone actually injects -----
  delete process.env.SLAYZONE_AGENT_MODE
  process.env.SLAYZONE_AGENT_ID = 'claude-code'
  const a = cliAuthor()
  check(
    'SLAYZONE_AGENT_ID => agent author with that id',
    a.type === 'agent' && a.id === 'claude-code',
    `got ${JSON.stringify(a)}`
  )

  // --- no agent env => user ---------------------------------------------------
  delete process.env.SLAYZONE_AGENT_ID
  delete process.env.SLAYZONE_AGENT_MODE
  const u = cliAuthor()
  check('no agent env => user author', u.type === 'user' && u.id === null, `got ${JSON.stringify(u)}`)
} finally {
  if (prevId === undefined) delete process.env.SLAYZONE_AGENT_ID
  else process.env.SLAYZONE_AGENT_ID = prevId
  if (prevMode === undefined) delete process.env.SLAYZONE_AGENT_MODE
  else process.env.SLAYZONE_AGENT_MODE = prevMode
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
