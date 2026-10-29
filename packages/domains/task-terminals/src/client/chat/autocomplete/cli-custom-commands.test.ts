/**
 * Claude chat's custom-command source: the CLI expands `.claude/commands/*.md`
 * itself, so the menu only names the command and sends the typed `/name args`.
 */
import { describe, expect, test } from 'vitest'
import type { CliCommandList, CommandInfo } from '@slayzone/terminal-contracts'
import { createCliCustomCommandsSource } from './sources/cli-custom-commands'
import type { AcceptCtx, ChatListApi } from './types'

const cmd = (over: Partial<CommandInfo> & { cliName: string }): CommandInfo => ({
  name: over.cliName,
  description: '',
  source: 'project',
  path: `/r/.claude/commands/${over.cliName.replace(/:/g, '/')}.md`,
  body: 'Do it',
  ...over
})

function listApi(cmds: CommandInfo[], calls: unknown[] = []): ChatListApi {
  return {
    listSkills: async () => [],
    listCommands: async (cwd, opts) => {
      calls.push({ cwd, opts })
      return cmds
    },
    listAgents: async () => [],
    listFiles: async () => []
  }
}

const cliList = (slashCommands: string[]): CliCommandList => ({
  slashCommands,
  terminalSlashCommands: [],
  skills: [],
  cliVersion: '2.1.312'
})

const ctxFor = (draft: string, tokenEnd = draft.length, over: Partial<AcceptCtx> = {}): AcceptCtx =>
  ({
    draft,
    setDraft: () => {},
    tokenStart: 0,
    tokenEnd,
    session: { tabId: 't', taskId: 'k', mode: 'claude-chat', cwd: '/r' },
    chat: {} as AcceptCtx['chat'],
    navigate: {} as AcceptCtx['navigate'],
    toast: () => {},
    ...over
  }) as AcceptCtx

describe('Claude custom-command source', () => {
  test('keeps the `commands` id and never expands templates', () => {
    const src = createCliCustomCommandsSource(listApi([]), null)
    expect(src.id).toBe('commands')
    expect(src.commandTrigger).toBe(true)
    expect(src.transformSubmit).toBeUndefined()
  })

  test('asks the server for sub-folder commands too', async () => {
    const calls: unknown[] = []
    await createCliCustomCommandsSource(listApi([], calls), null).fetch({ cwd: '/r' })
    expect(calls).toEqual([{ cwd: '/r', opts: { nested: true } }])
  })

  test('names items the way the CLI runs them, namespaces included', async () => {
    const src = createCliCustomCommandsSource(
      listApi([cmd({ cliName: 'x', description: 'Echo' }), cmd({ cliName: 'sub:z' })]),
      null
    )
    const items = await src.fetch({ cwd: '/r' })
    expect(items.map((i) => i.name)).toEqual(['sub:z', 'x'])
    expect(items.find((i) => i.name === 'x')?.description).toBe('Echo')
  })

  test('prefers whichever of file name / frontmatter name the CLI lists', async () => {
    const both = cmd({ cliName: 'file-name', name: 'fm-name' })
    const byFile = await createCliCustomCommandsSource(
      listApi([both]),
      cliList(['file-name'])
    ).fetch({
      cwd: '/r'
    })
    expect(byFile.map((i) => i.name)).toEqual(['file-name'])
    const byFm = await createCliCustomCommandsSource(listApi([both]), cliList(['fm-name'])).fetch({
      cwd: '/r'
    })
    expect(byFm.map((i) => i.name)).toEqual(['fm-name'])
    // No CLI list yet → the file name, which is how the CLI names commands.
    const noList = await createCliCustomCommandsSource(listApi([both]), null).fetch({ cwd: '/r' })
    expect(noList.map((i) => i.name)).toEqual(['file-name'])
  })

  test('a project command shadows a user command the CLI runs under the same name', async () => {
    const src = createCliCustomCommandsSource(
      listApi([
        cmd({ cliName: 'x', source: 'user', description: 'user' }),
        cmd({ cliName: 'x', source: 'project', description: 'project' })
      ]),
      null
    )
    const items = await src.fetch({ cwd: '/r' })
    expect(items.map((i) => `${i.source}:${i.description}`)).toEqual(['project:project'])
  })

  test('Enter sends the typed `/name args` unchanged', async () => {
    const src = createCliCustomCommandsSource(listApi([]), null)
    const x = cmd({
      cliName: 'x',
      body: 'First: $0 · all: $ARGUMENTS',
      argumentHint: '<fruit> <count>'
    })
    expect(src.submitText?.(x, ctxFor('/x MANGO 3', 2))).toBe('/x MANGO 3')
    const plain = cmd({ cliName: 'sub:z', body: 'no args used' })
    expect(src.submitText?.(plain, ctxFor('/sub', 4))).toBe('/sub:z')
  })

  test('Enter parks the command when its template takes arguments and none were typed', () => {
    const src = createCliCustomCommandsSource(listApi([]), null)
    expect(src.submitText?.(cmd({ cliName: 'x', body: 'Use $ARGUMENTS' }), ctxFor('/x'))).toBe(null)
    expect(src.submitText?.(cmd({ cliName: 'x', body: 'First: $0' }), ctxFor('/x'))).toBe(null)
  })

  test('Tab/click parks `/name ` for arguments and sends nothing', async () => {
    const src = createCliCustomCommandsSource(listApi([]), null)
    let draft = ''
    const toasts: string[] = []
    await src.accept(
      cmd({ cliName: 'x', body: 'Use $ARGUMENTS', argumentHint: '<fruit> <count>' }),
      ctxFor('/x', 2, { setDraft: (v) => (draft = v), toast: (m) => toasts.push(m) })
    )
    expect(draft).toBe('/x ')
    expect(toasts).toEqual(['/x <fruit> <count>: type the arguments, then press Enter'])
  })
})
