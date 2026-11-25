import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { currentPathScope } from '@slayzone/platform/path-scope'
import { runInScopeJail } from '../../computer/src/path-jail'
import { createFakeClaude } from '../../../shared/test-utils/fake-claude'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { resolveTaskComputerId } from '@slayzone/computers/server'
import { setTaskMoveSessionsDelegate } from '@slayzone/task/server'
import type { HubComputerGateway } from '@slayzone/computer-transport/server'
import {
  createFixtureChatRuntime,
  projectScopedDeps
} from '../../computer/src/project-scope.fixture'
import { createWorkspaceMoveHandlers } from '../../computer/src/handlers/workspace-move-handlers'
import { createComputerChatServices } from './computer-chat'
import { createComputerPlacement } from './computer-placement'
import { installComputerMoves } from './computer-move-host'
import { taskSessionStore } from './test-session-store'

test.each([false, true])(
  'real computer handlers migrate worktree and chat draft, child repository: %s',
  async (childRepo) => {
    const h = await createTestHarness()
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-move-integration-')))
    const fake = createFakeClaude({ root: join(dir, 'fake') })
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    const sourceProject = join(dir, 'source')
    const targetProject = join(dir, 'target')
    const thirdProject = join(dir, 'third')
    const source = childRepo ? join(sourceProject, 'nested') : sourceProject
    const target = childRepo ? join(targetProject, 'nested') : targetProject
    const third = childRepo ? join(thirdProject, 'nested') : thirdProject
    mkdirSync(source, { recursive: true })
    mkdirSync(target, { recursive: true })
    mkdirSync(third, { recursive: true })
    git(source, 'init')
    git(source, 'config', 'user.email', 'test@example.com')
    git(source, 'config', 'user.name', 'Test')
    writeFileSync(join(source, 'code'), 'original')
    git(source, 'add', '.')
    git(source, 'commit', '-m', 'initial')
    git(target, 'init')
    git(third, 'init')
    const worktree = join(dir, 'task-worktree')
    git(source, 'worktree', 'add', '-b', 'feature', worktree)
    writeFileSync(join(worktree, 'code'), 'staged')
    git(worktree, 'add', 'code')
    writeFileSync(join(worktree, 'code'), 'unfinished')
    h.db.exec(`INSERT INTO projects(id,name,color,default_computer_id) VALUES('project','Project','#000','source');
    INSERT INTO computers(id,name,platform,version,capabilities_json,created_at) VALUES('source','Source','linux','1','{}',0),('target','Target','linux','1','{}',0),('third','Third','linux','1','{}',0);
    INSERT INTO tasks(id,project_id,title,computer_id,has_worktree,worktree_computer_id) VALUES('task','project','Task','source',1,'source');
    INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','task','claude-chat',0);
    INSERT INTO chat_tab_state(tab_id,draft_text,rev,updated_at) VALUES('tab','draft to keep',1,1);`)
    if (childRepo) h.db.prepare("UPDATE tasks SET repo_name='nested' WHERE id='task'").run()
    const makeComputer = (id: string, folder: string) => {
      const scope = projectScopedDeps({ project: folder })
      const ctx = {
        config: {
          hubUrl: 'ws://hub/computers',
          name: id,
          allowedRoots: [dir],
          capabilities: ['proc'],
          binOverrideDir: fake.binDir
        },
        dialer: { notify: () => true },
        log: () => {}
      }
      const chat = createFixtureChatRuntime({
        stateDir: join(dir, `${id}-state`),
        hubScope: 'hub',
        computerId: () => id,
        getProjectPaths: scope.getProjectPaths,
        ctx
      } as never)
      const move = createWorkspaceMoveHandlers({
        ctx: ctx as never,
        stateDir: join(dir, `${id}-state`),
        hubScope: 'hub',
        project: (projectId) => scope.getProjectPaths().get(projectId) ?? undefined,
        paths: async (taskId) =>
          (
            (await chat.request({
              kind: 'taskPaths',
              value: { op: 'get', taskIds: [taskId] }
            })) as Array<{ worktreePath: string | null; baseDir: string | null }>
          )[0] ?? { worktreePath: null, baseDir: null },
        history: chat.moveHistoryModes,
        hasWork: () => false,
        stop: chat.stopForMove,
        setPaths: async (taskId, projectId, paths) => {
          await chat.request({
            kind: 'taskPaths',
            value: { op: 'set', taskId, projectId, ...paths, at: Date.now() }
          })
        }
      })
      return { chat, move, extraDir: scope.stateDir }
    }
    const pcs = {
      source: makeComputer('source', sourceProject),
      target: makeComputer('target', targetProject),
      third: makeComputer('third', thirdProject)
    }
    const online = new Set(['source', 'target', 'third'])
    let failThirdWrite = false
    const gateway = {
      listUsableComputers: () => [...online].map((computerId) => ({ computerId })),
      async request<T>(computerId: string, method: string, params: unknown): Promise<T> {
        if (!online.has(computerId)) throw new Error('Disconnected')
        if (
          failThirdWrite &&
          computerId === 'third' &&
          method === 'workspace.move' &&
          (params as { op: string }).op === 'write'
        ) {
          failThirdWrite = false
          online.delete('third')
          throw new Error('Disconnected during file transfer')
        }
        const pc = pcs[computerId as keyof typeof pcs]
        const invoke = async () =>
          (method === 'workspace.move'
            ? await pc.move.request(params)
            : await pc.chat.request(params)) as T
        const scope = currentPathScope()
        return scope ? runInScopeJail(await pc.chat.scopeJail(scope), invoke) : invoke()
      }
    }
    const placement = createComputerPlacement({
      db: h.slayDb,
      requireLogin: false,
      usable: gateway.listUsableComputers
    })
    const chat = createComputerChatServices({
      db: h.slayDb,
      legacyData: {
        ...createDbChatDataOps(h.slayDb, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: { read: async () => new Uint8Array() },
      request: (id, params) => gateway.request(id, 'chat.request', params),
      resolveComputer: placement.forTask,
      defaultComputer: async () => 'source',
      hasLiveTask: async () => false,
      admitComputer: async () => undefined
    })
    setTaskMoveSessionsDelegate(chat.taskMoveSessions)
    try {
      await pcs.source.chat.request({
        kind: 'taskPaths',
        value: {
          op: 'set',
          taskId: 'task',
          projectId: 'project',
          worktreePath: worktree,
          at: Date.now()
        }
      })
      expect(await chat.relay.ops.getTabState('tab')).toMatchObject({
        draft: { text: 'draft to keep' }
      })
      const moves = installComputerMoves({
        db: h.slayDb,
        gateway: () => gateway as unknown as HubComputerGateway,
        placement,
        revoke: async () => undefined,
        changed: () => undefined
      })
      expect(await moves.preview('task', 'target')).toMatchObject({
        ready: true,
        requiresMigration: true
      })
      await moves.begin({ taskId: 'task', computerId: 'target', allowFreshSessions: false })
      const result = await moves.run('task')
      expect(result, result.error ?? '').toMatchObject({ status: 'done' })
      expect(await resolveTaskComputerId(h.slayDb, 'task')).toBe('target')
      expect(await chat.relay.ops.getTabState('tab')).toMatchObject({
        draft: { text: 'draft to keep' }
      })
      const paths = (await pcs.target.chat.request({
        kind: 'taskPaths',
        value: { op: 'get', taskIds: ['task'] }
      })) as Array<{ worktreePath: string }>
      expect(readFileSync(join(paths[0].worktreePath, 'code'), 'utf8')).toBe('unfinished')
      expect(git(paths[0].worktreePath, 'show', ':code')).toBe('staged')
      expect(readFileSync(join(worktree, 'code'), 'utf8')).toBe('unfinished')
      expect(h.db.prepare("SELECT project_id FROM tasks WHERE id='task'").get()).toEqual({
        project_id: 'project'
      })
      await chat.relay.ops.saveTabDraft('tab', { text: 'updated on destination', attachments: [] })
      writeFileSync(join(paths[0].worktreePath, 'code'), 'edited on destination')
      await moves.begin({ taskId: 'task', computerId: 'source', allowFreshSessions: false })
      const returned = await moves.run('task')
      expect(returned, returned.error ?? '').toMatchObject({ status: 'done' })
      expect(await resolveTaskComputerId(h.slayDb, 'task')).toBe('source')
      expect(await chat.relay.ops.getTabState('tab')).toMatchObject({
        draft: { text: 'updated on destination' }
      })
      online.delete('target')
      expect(await moves.preview('task', 'third')).toMatchObject({ ready: true })
      failThirdWrite = true
      await moves.begin({ taskId: 'task', computerId: 'third', allowFreshSessions: false })
      expect((await moves.run('task')).status).toBe('failed')
      expect(await resolveTaskComputerId(h.slayDb, 'task')).toBe('source')
      expect(() => pcs.source.move.assertAvailable('task')).toThrow(/moving/)
      expect((await moves.cancel('task')).status).toBe('canceled')
      expect(() => pcs.source.move.assertAvailable('task')).not.toThrow()
      online.add('third')
      await moves.recover()
      expect(() => pcs.third.move.assertAvailable('task')).not.toThrow()
      await moves.begin({ taskId: 'task', computerId: 'third', allowFreshSessions: false })
      const final = await moves.run('task')
      expect(final, final.error ?? '').toMatchObject({ status: 'done' })
      expect(await resolveTaskComputerId(h.slayDb, 'task')).toBe('third')
      expect(await chat.relay.ops.getTabState('tab')).toMatchObject({
        draft: { text: 'updated on destination' }
      })
    } finally {
      setTaskMoveSessionsDelegate(null)
      for (const pc of Object.values(pcs)) {
        await pc.chat.close()
        rmSync(pc.extraDir, { recursive: true, force: true })
      }
      h.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  30_000
)

test('a destination without the project folder or repository: the preview says what is missing and clone fills it', async () => {
  const h = await createTestHarness()
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'computer-move-destination-')))
  const fake = createFakeClaude({ root: join(dir, 'fake') })
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const origin = join(dir, 'origin.git')
  const sourceProject = join(dir, 'source')
  const targetProject = join(dir, 'target')
  mkdirSync(origin, { recursive: true })
  git(origin, 'init', '--bare', '-q')
  mkdirSync(sourceProject, { recursive: true })
  git(sourceProject, 'init', '-q')
  git(sourceProject, 'config', 'user.email', 'test@example.com')
  git(sourceProject, 'config', 'user.name', 'Test')
  git(sourceProject, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(sourceProject, 'code'), 'original')
  git(sourceProject, 'add', '.')
  git(sourceProject, 'commit', '-qm', 'initial')
  git(sourceProject, 'remote', 'add', 'origin', origin)
  git(sourceProject, 'push', '-q', 'origin', 'HEAD')
  const worktree = join(dir, 'task-worktree')
  git(sourceProject, 'worktree', 'add', '-qb', 'feature', worktree)
  h.db.exec(`INSERT INTO projects(id,name,color,default_computer_id) VALUES('project','Project','#000','source');
  INSERT INTO computers(id,name,platform,version,capabilities_json,created_at) VALUES('source','Source','linux','1','{}',0),('target','Target','linux','1','{}',0);
  INSERT INTO tasks(id,project_id,title,computer_id,has_worktree,worktree_computer_id) VALUES('task','project','Task','source',1,'source');`)
  const makeComputer = (id: string, folders: Record<string, string>) => {
    const scope = projectScopedDeps(folders)
    const ctx = {
      config: {
        hubUrl: 'ws://hub/computers',
        name: id,
        allowedRoots: [dir],
        capabilities: ['proc'],
        binOverrideDir: fake.binDir
      },
      dialer: { notify: () => true },
      log: () => {}
    }
    const chat = createFixtureChatRuntime({
      stateDir: join(dir, `${id}-state`),
      hubScope: 'hub',
      computerId: () => id,
      getProjectPaths: scope.getProjectPaths,
      ctx
    } as never)
    const move = createWorkspaceMoveHandlers({
      ctx: ctx as never,
      stateDir: join(dir, `${id}-state`),
      hubScope: 'hub',
      project: (projectId) => scope.getProjectPaths().get(projectId) ?? undefined,
      paths: async (taskId) =>
        (
          (await chat.request({
            kind: 'taskPaths',
            value: { op: 'get', taskIds: [taskId] }
          })) as Array<{ worktreePath: string | null; baseDir: string | null }>
        )[0] ?? { worktreePath: null, baseDir: null },
      history: chat.moveHistoryModes,
      hasWork: () => false,
      stop: chat.stopForMove,
      setPaths: async () => undefined
    })
    return { chat, move, extraDir: scope.stateDir }
  }
  const targetFolders: Record<string, string> = {}
  const pcs = {
    source: makeComputer('source', { project: sourceProject }),
    target: makeComputer('target', targetFolders)
  }
  const gateway = {
    listUsableComputers: () => [{ computerId: 'source' }, { computerId: 'target' }],
    async request<T>(computerId: string, method: string, params: unknown): Promise<T> {
      const pc = pcs[computerId as keyof typeof pcs]
      const invoke = async () =>
        (method === 'workspace.move'
          ? await pc.move.request(params)
          : await pc.chat.request(params)) as T
      const scope = currentPathScope()
      return scope ? runInScopeJail(await pc.chat.scopeJail(scope), invoke) : invoke()
    }
  }
  const placement = createComputerPlacement({
    db: h.slayDb,
    requireLogin: false,
    usable: gateway.listUsableComputers
  })
  try {
    await pcs.source.chat.request({
      kind: 'taskPaths',
      value: { op: 'set', taskId: 'task', projectId: 'project', worktreePath: worktree, at: 0 }
    })
    const moves = installComputerMoves({
      db: h.slayDb,
      gateway: () => gateway as unknown as HubComputerGateway,
      placement,
      revoke: async () => undefined,
      changed: () => undefined
    })
    expect(await moves.preview('task', 'target')).toMatchObject({
      ready: false,
      destination: {
        folder: null,
        folderExists: false,
        repoRequired: true,
        repoReady: false,
        cloneUrl: origin
      }
    })
    targetFolders.project = targetProject
    expect(await moves.preview('task', 'target')).toMatchObject({
      ready: false,
      destination: { folder: targetProject, folderExists: false, repoPath: targetProject }
    })
    await moves.cloneRepository('task', 'target')
    expect(git(targetProject, 'remote', 'get-url', 'origin')).toBe(origin)
    expect(readFileSync(join(targetProject, 'code'), 'utf8')).toBe('original')
    expect(await moves.preview('task', 'target')).toMatchObject({
      ready: true,
      destination: { folderExists: true, repoReady: true }
    })
    // A folder already holding other files is never cloned into.
    rmSync(targetProject, { recursive: true, force: true })
    mkdirSync(targetProject)
    writeFileSync(join(targetProject, 'unrelated'), 'keep')
    await expect(moves.cloneRepository('task', 'target')).rejects.toThrow(/not empty/)
    expect(readFileSync(join(targetProject, 'unrelated'), 'utf8')).toBe('keep')
  } finally {
    for (const pc of Object.values(pcs)) {
      await pc.chat.close()
      rmSync(pc.extraDir, { recursive: true, force: true })
    }
    h.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
