/**
 * Tests only: the dispatch deps a spawn needs to be confined to a project's folder
 * (§9 Phase 7c) — a computer identity, a chat store dir, and project folders here.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { hubHostFromUrl } from '@slayzone/computer-transport/client'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChatRuntimeHandlers } from './handlers/chat-runtime'
import type { ProjectPathStore } from './project-paths'

export function projectScopedDeps(folders: Record<string, string>) {
  const store: ProjectPathStore = {
    get: (projectId) =>
      Object.hasOwn(folders, projectId) ? { path: folders[projectId], updatedAt: 0 } : null,
    set: async () => {
      throw new Error('fixture: read only')
    },
    forget: async () => undefined,
    list: () =>
      Object.entries(folders).map(([projectId, path]) => ({ projectId, path, updatedAt: 0 })),
    filePath: ''
  }
  return {
    getComputerId: () => 'fixture-computer',
    stateDir: mkdtempSync(join(tmpdir(), 'scoped-dispatch-')),
    getProjectPaths: () => store
  }
}

/**
 * Tests only: place project `projectId` at `folder` for the hub at `hubUrl` in the
 * `computer.projects.json` under `slayRoot` (what `SLAYZONE_ROOT` names), so a
 * spawn naming that project may start there (§9 Phase 7c). Write it before the
 * computer starts: the map is read once at boot.
 */
export function placeTestProject(
  slayRoot: string,
  hubUrl: string,
  projectId: string,
  folder: string
): void {
  const file = join(slayRoot, 'computer.projects.json')
  let map: Record<string, Record<string, { path: string; updatedAt: number }>> = {}
  try {
    map = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    /* none yet */
  }
  const host = hubHostFromUrl(hubUrl)
  map[host] = { ...(map[host] ?? {}), [projectId]: { path: realpathSync(folder), updatedAt: 0 } }
  mkdirSync(slayRoot, { recursive: true })
  writeFileSync(file, JSON.stringify(map))
}

type ChatRuntimeOptions = Parameters<typeof createChatRuntimeHandlers>[0] & {
  /**
   * The worktree a fixture task has on this computer (the hub keeps no path, §9 7e):
   * recorded before the task's first bootstrap when the computer holds no folder for
   * it yet — what the hub's task-path delivery (7a / v210 / v211) does in production.
   */
  taskFolder?: (taskId: string) => string | null | undefined
}

/**
 * Tests only: a computer chat runtime whose fixture tasks have folders here, as
 * production guarantees before any chat bootstrap (§9 Phase 7c): the agent starts
 * inside its task's own folders, which the computer learns from its project
 * placements and the task paths the hub delivers (Phase 7a / v210 handoff).
 * Fixtures create tasks by raw SQL and bootstrap directly, so this stands in for
 * that delivery:
 *  - every project is placed at the fixture's first allowed root (unless the
 *    fixture supplies its own `getProjectPaths` answer);
 *  - a bootstrap whose task has no folder here yet first records `taskFolder(taskId)`
 *    as its worktree, else (naming no project, fixture-only) its `cwd` as base dir.
 * Storage-only owners (no `cwd`) and the confinement itself are untouched.
 */
export function createFixtureChatRuntime(opts: ChatRuntimeOptions) {
  const root = opts.ctx.config.allowedRoots[0] ?? null
  const everyProject: ProjectPathStore = {
    get: () => (root ? { path: root, updatedAt: 0 } : null),
    set: async () => {
      throw new Error('fixture: read only')
    },
    forget: async () => undefined,
    list: () => [],
    filePath: ''
  }
  const h = createChatRuntimeHandlers({
    ...opts,
    getProjectPaths: () => opts.getProjectPaths() ?? everyProject
  })
  const request: typeof h.request = async (input) => {
    const req = input as {
      kind?: string
      value?: { projectId?: unknown; cwd?: unknown; identity?: { taskId?: unknown } }
    }
    const taskId = req.value?.identity?.taskId
    if (req.kind === 'bootstrap' && typeof taskId === 'string') {
      const worktreePath = opts.taskFolder?.(taskId) || null
      const baseDir =
        !worktreePath &&
        req.value?.projectId === null &&
        typeof req.value.cwd === 'string' &&
        req.value.cwd
          ? req.value.cwd
          : null
      if (worktreePath || baseDir) {
        const held = (await h.request({
          kind: 'taskPaths',
          value: { op: 'get', taskIds: [taskId] }
        })) as unknown[]
        if (held.length === 0)
          await h.request({
            kind: 'taskPaths',
            value: {
              op: 'set',
              taskId,
              projectId: typeof req.value?.projectId === 'string' ? req.value.projectId : null,
              worktreePath,
              baseDir,
              at: 1
            }
          })
      }
    }
    return h.request(input)
  }
  return Object.assign(Object.create(Object.getPrototypeOf(h)), h, { request }) as typeof h
}
