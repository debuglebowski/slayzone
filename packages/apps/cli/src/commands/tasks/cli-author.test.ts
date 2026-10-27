/**
 * cliAuthor() author-context resolution. The CLI runs inside an agent's
 * terminal; SlayZone injects the agent identity as `SLAYZONE_AGENT_ID` (the
 * mode string, see terminal/mcp-env.ts). cliAuthor must read THAT var to tag
 * CLI-authored artifacts/comments as agent-authored — reading a never-set var
 * silently mislabels every agent action as `user`.
 *
 * Pure Node (no native deps).
 */
import { afterEach, expect, test } from 'vitest'
import { cliAuthor } from './cli-author'

const prevId = process.env.SLAYZONE_AGENT_ID
const prevMode = process.env.SLAYZONE_AGENT_MODE
afterEach(() => {
  if (prevId === undefined) delete process.env.SLAYZONE_AGENT_ID
  else process.env.SLAYZONE_AGENT_ID = prevId
  if (prevMode === undefined) delete process.env.SLAYZONE_AGENT_MODE
  else process.env.SLAYZONE_AGENT_MODE = prevMode
})

// --- agent context: SLAYZONE_AGENT_ID is what SlayZone actually injects -----
test('SLAYZONE_AGENT_ID => agent author with that id', () => {
  delete process.env.SLAYZONE_AGENT_MODE
  process.env.SLAYZONE_AGENT_ID = 'claude-code'
  expect(cliAuthor()).toMatchObject({ type: 'agent', id: 'claude-code' })
})

// --- no agent env => user ---------------------------------------------------
test('no agent env => user author', () => {
  delete process.env.SLAYZONE_AGENT_ID
  delete process.env.SLAYZONE_AGENT_MODE
  expect(cliAuthor()).toMatchObject({ type: 'user', id: null })
})
