/**
 * Tests for the custom slash-command scanner (`~/.claude/commands`, `<cwd>/.claude/commands`).
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { listCommands } from './commands'

let tmp: string
let home: string
let cwd: string
const realHome = process.env.HOME

async function write(root: string, rel: string, text: string): Promise<void> {
  const file = path.join(root, '.claude', 'commands', rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'slz-commands-'))
  home = path.join(tmp, 'home')
  cwd = path.join(tmp, 'project')
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(cwd, { recursive: true })
  process.env.HOME = home
})

afterEach(async () => {
  process.env.HOME = realHome
  await fs.rm(tmp, { recursive: true, force: true })
})

test('default scan lists top-level commands only, as before', async () => {
  await write(cwd, 'x.md', '---\ndescription: Echo args\n---\nFirst: $0')
  await write(cwd, 'sub/z.md', 'nested body')
  const cmds = await listCommands(cwd)
  expect(cmds.map((c) => c.name)).toEqual(['x'])
  expect(cmds[0]).toMatchObject({
    name: 'x',
    description: 'Echo args',
    source: 'project',
    body: 'First: $0'
  })
})

test('frontmatter name still names the entry in the default scan', async () => {
  await write(cwd, 'file-name.md', '---\nname: fm-name\n---\nbody')
  const [cmd] = await listCommands(cwd)
  expect(cmd.name).toBe('fm-name')
})

test('cliName is the name the Claude CLI runs the file under', async () => {
  await write(cwd, 'file-name.md', '---\nname: fm-name\n---\nbody')
  const [cmd] = await listCommands(cwd)
  expect(cmd.cliName).toBe('file-name')
})

test('argument-hint is read from frontmatter', async () => {
  await write(cwd, 'x.md', '---\ndescription: d\nargument-hint: <fruit> <count>\n---\nbody')
  const [cmd] = await listCommands(cwd)
  expect(cmd.argumentHint).toBe('<fruit> <count>')
})

test('nested scan adds sub-folder commands under their namespaced CLI name', async () => {
  await write(cwd, 'x.md', 'top')
  await write(cwd, 'sub/z.md', '---\ndescription: namespaced\n---\nZ_OK $ARGUMENTS')
  await write(cwd, 'a/b/c.md', 'deep')
  const cmds = await listCommands(cwd, { nested: true })
  expect(cmds.map((c) => c.cliName)).toEqual(['a:b:c', 'sub:z', 'x'])
  const z = cmds.find((c) => c.cliName === 'sub:z')
  expect(z).toMatchObject({ name: 'sub:z', description: 'namespaced', source: 'project' })
})

test('nested scan ignores non-markdown files and empty folders', async () => {
  await write(cwd, 'notes.txt', 'not a command')
  await fs.mkdir(path.join(cwd, '.claude', 'commands', 'empty'), { recursive: true })
  await write(cwd, 'x.md', 'top')
  const cmds = await listCommands(cwd, { nested: true })
  expect(cmds.map((c) => c.cliName)).toEqual(['x'])
})

test('project commands win over user commands with the same name', async () => {
  await write(home, 'x.md', '---\ndescription: user one\n---\nuser')
  await write(home, 'only-user.md', 'u')
  await write(cwd, 'x.md', '---\ndescription: project one\n---\nproject')
  const cmds = await listCommands(cwd, { nested: true })
  expect(cmds.map((c) => `${c.source}:${c.cliName}`)).toEqual(['user:only-user', 'project:x'])
  expect(cmds.find((c) => c.cliName === 'x')?.description).toBe('project one')
})
