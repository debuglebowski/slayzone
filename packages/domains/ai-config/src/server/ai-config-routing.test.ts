/**
 * The AI-config ops read and write the files where they live: a project's on the
 * project's computer, the computer-level ones (`~/.claude`, …) on an explicit
 * computer, else the caller's own — every fs call one `agentConfig.fs` request. So
 * they work on a hub with processes switched off; with no computer, every hub says
 * "connect a computer" (`NO_COMPUTER_CONNECTED`) — the hub's own disk is never read.
 */
import { currentPathScope } from '@slayzone/platform/path-scope'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { TRPCError } from '@trpc/server'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { initAiConfigOps } from '@slayzone/ai-config/server'
import { aiConfigRouter } from './ai-config-router.js'
import { localAiConfigFs } from './ai-config-fs'
import { setAiConfigFsRouting, type AiConfigFsCall } from './ai-config-fs-routing'

const h = await createTestHarness()
const projectPath = h.tmpDir()
const computerHome = h.tmpDir()
fs.writeFileSync(path.join(projectPath, 'CLAUDE.md'), 'project instructions')

const calls: Array<{ computerId: string; call: AiConfigFsCall }> = []
const targets: unknown[] = []
let computer: string | null = 'c1'

/** A computer: its own disk via the same local fs, its own home. */
async function serve(computerId: string, call: AiConfigFsCall): Promise<unknown> {
  calls.push({ computerId, call })
  const f = localAiConfigFs
  switch (call.op) {
    case 'homedir':
      return computerHome
    case 'exists':
      return f.exists(call.path)
    case 'readFile':
      return f.readFile(call.path)
    case 'writeFile':
      return f.writeFile(call.path, call.content)
    case 'mkdir':
      return f.mkdir(call.path)
    case 'unlink':
      return f.unlink(call.path)
    case 'rmdir':
      return f.rmdir(call.path)
    case 'rename':
      return f.rename(call.path, call.to)
    case 'stat':
      return f.stat(call.path)
    case 'readdir':
      return f.readdir(call.path)
  }
}

beforeAll(async () => {
  await initAiConfigOps(h.slayDb)
})

function route(): void {
  setAiConfigFsRouting({
    computerForProject: async (t) => {
      targets.push(t)
      return computer
    },
    computerForCaller: async (id) => {
      targets.push({ caller: id ?? null })
      return computer
    },
    request: serve
  })
}

afterEach(() => {
  calls.length = 0
  targets.length = 0
  computer = 'c1'
  setAiConfigFsRouting(null)
  delete process.env.SLAYZONE_HUB_ENABLE_PROCESSES
})

const caller = aiConfigRouter.createCaller({ db: h.slayDb, dataRoot: '' } as never)

describe('AI config on the computer', () => {
  test("a project file is read on the project's computer — on a processes-off hub too", async () => {
    route()
    process.env.SLAYZONE_HUB_ENABLE_PROCESSES = '0'
    const content = await caller.readContextFile({
      projectId: 'p-test',
      filePath: path.join(projectPath, 'CLAUDE.md'),
      projectPath
    })
    expect(content).toBe('project instructions')
    expect(targets[0]).toMatchObject({ projectId: 'p-test' })
    expect(calls.some((c) => c.computerId === 'c1' && c.call.op === 'readFile')).toBe(true)
  })

  test("computer-level files: that computer's home, an explicit computer first", async () => {
    route()
    fs.mkdirSync(path.join(computerHome, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(computerHome, '.claude', 'CLAUDE.md'), 'global')
    const files = await caller.getComputerFiles({ computerId: 'c1' })
    expect(targets).toEqual([{ caller: 'c1' }])
    expect(JSON.stringify(files)).toContain(path.join(computerHome, '.claude', 'CLAUDE.md'))
  })

  test('no computer, on any hub: NO_COMPUTER_CONNECTED, nothing read', async () => {
    route()
    computer = null
    const err = await caller
      .readContextFile({
        projectId: 'p-test',
        filePath: path.join(projectPath, 'CLAUDE.md'),
        projectPath
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TRPCError)
    expect((err as TRPCError).code).toBe('FORBIDDEN')
    expect(calls).toHaveLength(0)
  })
})

describe('§9 Phase 7c: a project file is reached under its path scope, never by its path', () => {
  test('a project folder named without a project / task: refused, nothing routed or read', async () => {
    route()
    const err = await caller
      .readContextFile({ filePath: path.join(projectPath, 'CLAUDE.md'), projectPath })
      .catch((e: unknown) => e)
    expect(String(err)).toMatch(/must name the task or project/)
    expect(targets).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('the project scope rides every agentConfig.fs call', async () => {
    const scopes: unknown[] = []
    setAiConfigFsRouting({
      computerForProject: async () => 'c1',
      computerForCaller: async () => 'c1',
      request: async (computerId, call) => {
        scopes.push(currentPathScope())
        return serve(computerId, call)
      }
    })
    await caller.readContextFile({
      projectId: 'p-test',
      filePath: path.join(projectPath, 'CLAUDE.md'),
      projectPath
    })
    expect(scopes.length).toBeGreaterThan(0)
    for (const scope of scopes.filter(Boolean))
      expect(scope).toMatchObject({ kind: 'project', projectId: 'p-test' })
    expect(scopes.at(-1)).toMatchObject({ kind: 'project', projectId: 'p-test' })
  })

  test('only the context-file read / write serve computer-level files unscoped', async () => {
    route()
    const err = await caller
      .discoverMcpConfigs({ projectPath: '' } as never)
      .catch((e: unknown) => e)
    expect(String(err)).toMatch(/must name the task or project/)
  })
})

describe('every AI-config write lands on the computer (siblings of QA 964073b0 5b)', () => {
  const wrote = (op: AiConfigFsCall['op'], p: string) =>
    calls.some(
      (c) => c.computerId === 'c1' && c.call.op === op && 'path' in c.call && c.call.path === p
    )

  test('computer-level: context file edit, skill create/write/delete, MCP add/remove', async () => {
    route()
    const claudeDir = path.join(computerHome, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    const globalMd = path.join(claudeDir, 'CLAUDE.md')
    await caller.writeContextFile({ filePath: globalMd, content: 'edited', projectPath: '' })
    expect(fs.readFileSync(globalMd, 'utf-8')).toBe('edited')
    expect(wrote('writeFile', globalMd)).toBe(true)

    const created = await caller.createComputerFile({
      provider: 'claude',
      category: 'skill',
      slug: 'qa-skill'
    })
    expect(fs.existsSync(created.path)).toBe(true)

    await caller.writeComputerSkill({ provider: 'claude', slug: 'qa-skill', content: 'v2' })
    const skillMd = path.join(claudeDir, 'skills', 'qa-skill', 'SKILL.md')
    expect(fs.readFileSync(skillMd, 'utf-8')).toBe('v2')
    expect(wrote('writeFile', skillMd)).toBe(true)

    await caller.deleteComputerFile({ filePath: created.path })
    expect(fs.existsSync(created.path)).toBe(false)
    expect(wrote('unlink', created.path)).toBe(true)

    await caller.writeComputerMcpServer({
      provider: 'claude',
      serverKey: 'qa',
      config: { command: 'echo', args: [] }
    })
    const mcp = await caller.discoverComputerMcpConfigs()
    expect(JSON.stringify(mcp)).toContain('"qa"')
    await caller.removeComputerMcpServer({ provider: 'claude', serverKey: 'qa' })
    expect(JSON.stringify(await caller.discoverComputerMcpConfigs())).not.toContain('"qa"')
  })

  test('project-level: MCP add/remove, context file rename/delete', async () => {
    route()
    const dir = h.tmpDir()
    await caller.writeMcpServer({
      projectId: 'p-test',
      projectPath: dir,
      provider: 'claude',
      serverKey: 'qa',
      config: { command: 'echo', args: [] }
    })
    expect(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf-8')).toContain('"qa"')
    expect(wrote('writeFile', path.join(dir, '.mcp.json'))).toBe(true)
    await caller.removeMcpServer({
      projectId: 'p-test',
      projectPath: dir,
      provider: 'claude',
      serverKey: 'qa'
    })
    expect(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf-8')).not.toContain('"qa"')

    const from = path.join(dir, 'CLAUDE.md')
    const to = path.join(dir, 'AGENTS.md')
    fs.writeFileSync(from, 'x')
    await caller.renameContextFile({
      projectId: 'p-test',
      oldPath: from,
      newPath: to,
      projectPath: dir
    })
    expect(fs.existsSync(to) && !fs.existsSync(from)).toBe(true)
    await caller.deleteContextFile({ filePath: to, projectPath: dir, projectId: 'none' })
    expect(fs.existsSync(to)).toBe(false)
  })
})

describe('editing a project instructions file (pushProviderInstructions)', () => {
  // QA 964073b0 row 5b: a project with no `root_instructions` item yet — the editor's
  // save threw "No instructions to push" on the hub before any write reached the
  // computer, and the client swallowed it.
  test('a project with no instructions item yet: the edit is written on the computer', async () => {
    route()
    const projectId = crypto.randomUUID()
    const dir = h.tmpDir()
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'line 1\n')
    await h.slayDb
      .prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)')
      .run(projectId, 'fresh', '#000')

    await caller.pushProviderInstructions({
      projectId,
      projectPath: dir,
      provider: 'codex',
      content: 'line 1\nline 2\n'
    })

    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf-8')).toBe('line 1\nline 2\n')
    expect(
      calls.some(
        (c) =>
          c.computerId === 'c1' &&
          c.call.op === 'writeFile' &&
          c.call.path === path.join(dir, 'AGENTS.md')
      )
    ).toBe(true)
    // Reopening the editor reads the edit back.
    const reread = await caller.readProviderInstructions({
      projectId: 'p-test',
      projectPath: dir,
      provider: 'codex'
    })
    expect(reread.content).toBe('line 1\nline 2\n')
    // A plain edit: the project is not opted into managed instructions.
    const items = await h.slayDb
      .prepare('SELECT id FROM ai_config_items WHERE project_id = ?')
      .all(projectId)
    expect(items).toHaveLength(0)
  })
})
