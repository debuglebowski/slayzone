/**
 * The desktop logic the chat view reuses, imported the way the app imports it — through
 * the packages' DOM-free subpaths — in React Native's test environment. A module that
 * touches the DOM at import time fails here, and so does any runtime import of a
 * desktop-only package or of a Node built-in (the app's bundler resolves no `node:`
 * module): each is mocked to throw when loaded (type-only imports are erased and never
 * load). Same guard as `../shared-logic.test.ts`, for the chat's set.
 */
import {
  type CliCommandList,
  type CommandInfo,
  chatCapabilitiesForMode
} from '@slayzone/terminal-contracts'
import { taskProjectRoot } from '@slayzone/projects-contracts/placements'
import { mainTerminalCwd, mainTerminalCwdNeedsRepos } from '@slayzone/task/main-terminal'
import {
  availableBuiltins,
  builtinCommands,
  cliCommandItems,
  customCommandItems,
  rankByName,
  resetChat,
  resolveEnter,
  takesArguments
} from '@slayzone/task-terminals/slash-commands'
import { LiveBlockStore } from '@slayzone/terminal/live-blocks'
import { lexer } from 'marked'

// Node built-ins: what a server-side module of a shared package pulls in.
jest.mock('node:crypto', () => {
  throw new Error('node:crypto (a Node built-in) loaded')
})
jest.mock('node:fs', () => {
  throw new Error('node:fs (a Node built-in) loaded')
})
jest.mock('node:path', () => {
  throw new Error('node:path (a Node built-in) loaded')
})
jest.mock('node:os', () => {
  throw new Error('node:os (a Node built-in) loaded')
})
jest.mock('@slayzone/ui', () => {
  throw new Error('@slayzone/ui (desktop UI kit) loaded')
})
jest.mock('@slayzone/ui/secure-context', () => {
  throw new Error('@slayzone/ui/secure-context (desktop UI kit) loaded')
})
jest.mock('react-dom', () => {
  throw new Error('react-dom loaded')
})
jest.mock('lucide-react', () => {
  throw new Error('lucide-react (DOM icons) loaded')
})
jest.mock('@slayzone/transport/client', () => {
  throw new Error('@slayzone/transport/client (the tRPC runtime) loaded by pure logic')
})

describe('@slayzone/task/main-terminal + @slayzone/projects-contracts/placements', () => {
  it("resolves a chat tab's folder the way desktop and the hub do", () => {
    const project = {
      selected_repo: null,
      placements: [{ computer_id: 'c1', path: '/p', status: 'ready' as const }],
      resolved_computer_id: 'c1'
    }
    const plain = { worktree_path: null, base_dir: null, repo_name: null, computer_id: null }
    const root = taskProjectRoot(plain, project)
    expect(root).toBe('/p')
    expect(mainTerminalCwd({ ...plain, worktree_path: '/wt' }, project, root, [])).toBe('/wt')
    expect(mainTerminalCwd(plain, project, root, [])).toBe('/p')
    const bound = { ...plain, repo_name: 'api' }
    expect(mainTerminalCwdNeedsRepos(bound, project, root)).toBe(true)
    expect(mainTerminalCwd(bound, project, root, [{ name: 'api', path: '/p/api' }])).toBe('/p/api')
  })
})

describe('@slayzone/task-terminals/slash-commands', () => {
  const cliList: CliCommandList = {
    slashCommands: ['compact', 'init', 'review', 'my-skill', 'statusline', '__internal'],
    skills: ['my-skill'],
    terminalSlashCommands: ['statusline']
  } as CliCommandList

  it("offers desktop's builtins, minus the ones the CLI runs itself", () => {
    const names = availableBuiltins({
      cliCommandNames: new Set(cliCommandItems(cliList).map((c) => c.name)),
      capabilities: chatCapabilitiesForMode('claude-chat')
    }).map((b) => b.name)
    expect(names).toContain('clear')
    expect(names).toContain('model')
    // `cli-wins` builtins hide behind the CLI's own command.
    expect(names).not.toContain('init')
    expect(builtinCommands.map((b) => b.name)).toContain('init')
  })

  it("lists the CLI's chat commands without terminal-only and internal ones", () => {
    expect(cliCommandItems(cliList).map((c) => [c.name, c.kind])).toEqual([
      ['compact', 'command'],
      ['init', 'command'],
      ['review', 'command'],
      ['my-skill', 'skill']
    ])
  })

  it('names custom commands the way the CLI runs them, a project file beating a user file', () => {
    const cmd = (fields: Partial<CommandInfo>): CommandInfo =>
      ({ name: 'x', description: '', body: '', source: 'user', ...fields }) as CommandInfo
    const items = customCommandItems(
      [
        cmd({ name: 'deploy', source: 'user', description: 'user' }),
        cmd({ name: 'deploy', source: 'project', description: 'project', body: 'ship $ARGUMENTS' })
      ],
      null
    )
    expect(items.map((c) => [c.name, c.description])).toEqual([['deploy', 'project']])
    expect(takesArguments(items[0])).toBe(true)
  })

  it('ranks names and Enter like the desktop menu', () => {
    const ranked = rankByName([{ n: 'compact' }, { n: 'context' }, { n: 'clear' }], 'cle', {
      getName: (i) => i.n
    })
    expect(ranked[0].n).toBe('clear')
    expect(
      resolveEnter({ query: 'comp', names: ['compact'], selectedIndex: 0, navigated: false })
    ).toEqual({ kind: 'entry', index: 0 })
    expect(typeof resetChat).toBe('function')
  })
})

describe('@slayzone/terminal/live-blocks', () => {
  it('notifies only the row whose live block changed', () => {
    const store = new LiveBlockStore()
    const a = jest.fn()
    const b = jest.fn()
    store.subscribe('text:m:0', a)
    store.subscribe('text:m:1', b)
    store.publish([{ key: 'text:m:0', text: 'hi', json: '' }])
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    expect(store.get('text:m:0')?.text).toBe('hi')
  })
})

describe('marked', () => {
  it('lexes GitHub-flavoured markdown without a DOM', () => {
    const tokens = lexer('| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~ **bold**')
    expect(tokens.map((t) => t.type)).toEqual(['table', 'space', 'paragraph'])
  })
})
