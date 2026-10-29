/**
 * Menu descriptions for Claude Code's own slash commands. The CLI advertises
 * names only, so this is best-effort enrichment: a command missing here still
 * shows (with a generic description) — availability always comes from the CLI.
 */
export const CLI_COMMAND_DESCRIPTIONS: Readonly<Record<string, string>> = {
  compact: 'Summarize the conversation to free up context',
  context: 'Show what fills the context window',
  cost: 'Show session cost and plan usage',
  usage: 'Show session cost and plan usage',
  init: 'Create a CLAUDE.md for this project',
  review: 'Review a pull request',
  'security-review': 'Security review of the pending changes',
  'output-style': 'Set the output style',
  rename: 'Rename this conversation',
  fast: 'Toggle fast mode',
  heapdump: 'Write a heap snapshot of the CLI process'
}

export function describeCliCommand(name: string, isSkill: boolean): string {
  return CLI_COMMAND_DESCRIPTIONS[name] ?? (isSkill ? 'Skill' : 'Claude Code command')
}
