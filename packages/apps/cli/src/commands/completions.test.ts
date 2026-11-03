import { Command } from 'commander'
import { expect, test } from 'vitest'
import { bashScript, fishScript, zshScript } from './completions'
import { chatCommand } from './chat'

function program(): Command {
  const root = new Command('slay')
  root.addCommand(chatCommand())
  root.addCommand(new Command('update').option('--check', "Report what's available"))
  root.addCommand(new Command('secret'), { hidden: true })
  return root
}

test('every visible command and its subcommands complete, in every shell', () => {
  for (const script of [fishScript(program()), zshScript(program()), bashScript(program())]) {
    expect(script).toContain('chat')
    expect(script).toContain('prompts')
    expect(script).toContain('respond')
    expect(script).not.toContain('secret')
  }
})

test('descriptions with quotes stay quoted', () => {
  expect(fishScript(program())).toContain("task\\'s chat-mode agent")
  expect(zshScript(program())).toContain("'--check'")
  expect(zshScript(program())).toContain("task'\\''s chat-mode agent")
})
