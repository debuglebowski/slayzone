import {
  type AgentInfo,
  type ChatCapabilities,
  type CliCommandList,
  type CommandInfo,
  chatCapabilitiesForMode,
  chatModelsView,
  type SkillInfo
} from '@slayzone/terminal-contracts'
import {
  acceptSlash,
  enterSlash,
  planSend,
  rankSlash,
  slashItems,
  slashQuery,
  usageTarget
} from './slash-menu'

const CLAUDE: ChatCapabilities = chatCapabilitiesForMode('claude-chat')
const CODEX: ChatCapabilities = chatCapabilitiesForMode('codex-chat')
/** The pickers' models and the chat's current one (`chat.getModels`, `chat.getModel`). */
const CLAUDE_MODELS = { view: chatModelsView('claude-chat', undefined), current: 'opus' }
const CODEX_MODELS = {
  view: chatModelsView('codex-chat', [
    {
      id: 'gpt-6-luna',
      label: 'GPT-6 Luna',
      supportsEffort: true,
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'ultra', label: 'Ultra' }
      ]
    },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', supportsEffort: false }
  ]),
  current: 'gpt-6-luna'
}

const cliList = {
  slashCommands: ['compact', 'init', 'my-skill', 'deploy', 'statusline'],
  skills: ['my-skill'],
  terminalSlashCommands: ['statusline']
} as CliCommandList
const skill = (name: string): SkillInfo => ({ name, description: `${name} skill` }) as SkillInfo
const agent = (name: string): AgentInfo => ({ name, description: `${name} agent` }) as AgentInfo
const command = (name: string, body = 'do it', fields: Partial<CommandInfo> = {}): CommandInfo =>
  ({ name, description: `${name} command`, body, source: 'project', ...fields }) as CommandInfo

describe('slashQuery', () => {
  it('is the typed command name while the draft is a lone /token', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/comp')).toBe('comp')
    expect(slashQuery('/compact now')).toBeNull()
    expect(slashQuery('hello /x')).toBeNull()
  })
})

describe('slashItems', () => {
  it("lists desktop's sources, the CLI's own commands behind richer local entries", () => {
    const items = slashItems(
      {
        skills: [skill('my-skill')],
        commands: [command('deploy')],
        agents: [agent('reviewer')],
        cliList
      },
      CLAUDE
    )
    const byName = (name: string) => items.filter((i) => i.name === name).map((i) => i.type)
    expect(byName('my-skill')).toEqual(['skill'])
    expect(byName('deploy')).toEqual(['command'])
    expect(byName('compact')).toEqual(['cli'])
    expect(byName('reviewer')).toEqual(['agent'])
    expect(byName('clear')).toEqual(['builtin'])
    // The CLI runs its own /init; terminal-only commands never show.
    expect(byName('init')).toEqual(['cli'])
    expect(byName('statusline')).toEqual([])
  })

  it('offers no CLI commands where the provider does not run them', () => {
    const items = slashItems({ skills: [], commands: [], agents: [], cliList }, CODEX)
    expect(items.some((i) => i.type === 'cli')).toBe(false)
    expect(items.some((i) => i.name === 'model')).toBe(false)
  })
})

describe('rankSlash', () => {
  it('ranks by name, then description, usage breaking ties', () => {
    const items = slashItems(
      { skills: [skill('compose')], commands: [], agents: [], cliList },
      CLAUDE
    )
    expect(rankSlash(items, 'compact', {})[0].name).toBe('compact')
    const tie = rankSlash(items, '', { skills: { compose: 9 } })
    expect(tie[0].name).toBe('compose')
  })
})

describe('acceptSlash (a tap on an entry)', () => {
  it('runs a builtin with the draft cleared', () => {
    const [clear] = slashItems(
      { skills: [], commands: [], agents: [], cliList: null },
      CLAUDE
    ).filter((i) => i.name === 'clear')
    const action = acceptSlash(clear, '/cl', CLAUDE)
    expect(action.type).toBe('run')
    expect(action.draft).toBe('')
  })

  it('parks /name for a skill, a CLI command or a command file', () => {
    const items = slashItems(
      { skills: [skill('s')], commands: [command('c', 'ship $ARGUMENTS')], agents: [], cliList },
      CLAUDE
    )
    const pick = (name: string) => acceptSlash(items.find((i) => i.name === name)!, '/x', CLAUDE)
    expect(pick('s')).toEqual({ type: 'draft', draft: '/s ' })
    expect(pick('compact')).toEqual({ type: 'draft', draft: '/compact ' })
    expect(pick('c')).toEqual({
      type: 'draft',
      draft: '/c ',
      hint: '/c: type the arguments, then press Send'
    })
  })

  it('starts an agent request', () => {
    const [reviewer] = slashItems(
      { skills: [], commands: [], agents: [agent('reviewer')], cliList: null },
      CLAUDE
    ).filter((i) => i.type === 'agent')
    expect(acceptSlash(reviewer, '/rev', CLAUDE)).toEqual({
      type: 'draft',
      draft: 'Use the reviewer agent to '
    })
  })

  it('expands a command file here where the provider does not run commands (Codex)', () => {
    const items = slashItems(
      { skills: [], commands: [command('hello', 'Say hello')], agents: [], cliList: null },
      CODEX
    )
    expect(acceptSlash(items.find((i) => i.name === 'hello')!, '/he', CODEX)).toEqual({
      type: 'send',
      text: 'Say hello',
      draft: ''
    })
  })
})

describe('enterSlash (Send while the menu is open)', () => {
  const items = slashItems(
    { skills: [], commands: [command('deploy', 'ship $ARGUMENTS')], agents: [], cliList },
    CLAUDE
  )

  it('runs the exact or completing entry the way the CLI would get it', () => {
    expect(enterSlash('/compact', rankSlash(items, 'compact', {}), CLAUDE)).toEqual({
      type: 'send',
      text: '/compact',
      draft: ''
    })
    expect(enterSlash('/comp', rankSlash(items, 'comp', {}), CLAUDE)).toEqual({
      type: 'send',
      text: '/compact',
      draft: ''
    })
  })

  it('parks a command file that needs arguments none were typed for', () => {
    expect(enterSlash('/deploy', rankSlash(items, 'deploy', {}), CLAUDE).type).toBe('draft')
  })

  it("passes an unknown command through for the CLI's own answer", () => {
    expect(enterSlash('/zzz', rankSlash(items, 'zzz', {}), CLAUDE)).toEqual({ type: 'passthrough' })
    // A fuzzy match that the typed name does not start: the CLI answers it, not the menu.
    const fuzzy = rankSlash(items, 'cmpt', {})
    expect(fuzzy.length).toBeGreaterThan(0)
    expect(enterSlash('/cmpt', fuzzy, CLAUDE)).toEqual({ type: 'passthrough' })
  })
})

describe('planSend', () => {
  it("handles /effort and /model in the app (the pills' path), like desktop", () => {
    expect(planSend('/effort high', CLAUDE_MODELS, CLAUDE, [])).toEqual({
      type: 'effort',
      level: 'high'
    })
    expect(planSend('/effort warp', CLAUDE_MODELS, CLAUDE, []).type).toBe('invalid')
    expect(planSend('/model sonnet', CLAUDE_MODELS, CLAUDE, [])).toEqual({
      type: 'model',
      id: 'sonnet'
    })
    expect(planSend('/model nope', CLAUDE_MODELS, CLAUDE, []).type).toBe('invalid')
  })

  it("/effort takes the current model's own levels (Codex: what its CLI listed)", () => {
    expect(planSend('/effort ultra', CODEX_MODELS, CODEX, [])).toEqual({
      type: 'effort',
      level: 'ultra'
    })
    expect(planSend('/effort max', CODEX_MODELS, CODEX, [])).toEqual({
      type: 'invalid',
      message: 'Invalid effort level "max". Use: low, ultra'
    })
    // A Codex model that lists no levels: refused, Claude's levels are no fallback.
    expect(planSend('/effort low', { ...CODEX_MODELS, current: 'gpt-6.1-sol' }, CODEX, [])).toEqual(
      {
        type: 'invalid',
        message: 'GPT-6.1 Sol has no effort levels.'
      }
    )
  })

  it('expands command files where the provider does not run them, else sends as typed', () => {
    expect(
      planSend('/hello world', CODEX_MODELS, CODEX, [command('hello', 'Hi $ARGUMENTS')])
    ).toEqual({
      type: 'send',
      text: 'Hi world'
    })
    expect(
      planSend('/hello world', CLAUDE_MODELS, CLAUDE, [command('hello', 'Hi $ARGUMENTS')])
    ).toEqual({
      type: 'send',
      text: '/hello world'
    })
    expect(planSend('  ', CLAUDE_MODELS, CLAUDE, [])).toEqual({ type: 'empty' })
  })
})

describe('usageTarget', () => {
  it('names the entry a sent /command counts for, the picked one first', () => {
    const items = slashItems(
      { skills: [skill('x')], commands: [command('x')], agents: [], cliList: null },
      CLAUDE
    )
    expect(usageTarget('/x go', items, null)).toEqual({ source: 'commands', name: 'x' })
    expect(usageTarget('/x go', items, { source: 'skills', name: 'x' })).toEqual({
      source: 'skills',
      name: 'x'
    })
    expect(usageTarget('plain text', items, null)).toBeNull()
  })
})
