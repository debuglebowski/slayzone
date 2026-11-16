/** Computer-owned, replayable folder relocation. The journal survives a lost RPC
 * or host restart; project/task IDs and all history stay where they are. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir } from 'node:fs/promises'
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { ProjectPathStore } from './project-paths'
import { judgePath } from './path-jail'

const planSchema = z.object({
  projectId: z.string(),
  source: z.string(),
  target: z.string(),
  mode: z.enum(['move', 'update']),
  identity: z.object({ dev: z.number(), ino: z.number() }),
  repos: z.array(z.object({ root: z.string(), worktrees: z.array(z.string()) }))
})
type Plan = z.infer<typeof planSchema>

export function isWithinDirectory(path: string, root: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

export function relocatedPath(path: string, source: string, target: string): string {
  return isWithinDirectory(path, source) ? join(target, relative(source, path)) : path
}

const execGit = promisify(execFile)
const git = async (root: string, args: string[]) =>
  (
    await execGit('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024
    })
  ).stdout

/** Find nested repositories without following symlinks or scanning dependency trees. */
async function repositories(root: string, previousRoot = root): Promise<Plan['repos']> {
  const out: Plan['repos'] = []
  const linked = new Set<string>()
  const visit = async (dir: string): Promise<void> => {
    if (existsSync(join(dir, '.git')) && !linked.has(dir)) {
      const entries = (await git(dir, ['worktree', 'list', '--porcelain', '-z'])).split('\0')
      const worktrees = entries.filter((v) => v.startsWith('worktree ')).map((v) => v.slice(9))
      for (const path of worktrees.slice(1)) linked.add(relocatedPath(path, previousRoot, root))
      // Repair from the main checkout: a moved linked checkout's own .git may
      // still name its old location and cannot be used to start Git yet.
      const mainRoot = worktrees[0]
      if (!mainRoot) throw new Error(`Cannot resolve Git repository at '${dir}'.`)
      if (!out.some((r) => r.root === mainRoot))
        out.push({ root: mainRoot, worktrees: worktrees.slice(1) })
    }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        ['.git', 'node_modules', '.pnpm', '.venv', 'vendor'].includes(entry.name)
      )
        continue
      await visit(join(dir, entry.name))
    }
  }
  await visit(root)
  return out
}

export function createProjectRelocation(opts: {
  store: () => ProjectPathStore
  roots: () => string[]
  assertIdle: (projectId: string) => void | Promise<void>
  remap: (projectId: string, source: string, target: string) => void | Promise<void>
}) {
  let busy = false
  let recovered = false
  const journal = () =>
    opts.store().relocationFilePath ?? `${opts.store().filePath}.relocation.json`
  const allowed = (path: string) => judgePath(path, opts.roots())

  async function finish(plan: Plan): Promise<void> {
    const source = plan.source ? allowed(plan.source) : allowed(plan.target)
    const target = allowed(plan.target)
    if (plan.mode === 'move' && existsSync(source)) {
      const actual = lstatSync(source)
      if (actual.dev !== plan.identity.dev || actual.ino !== plan.identity.ino)
        throw new Error('Source folder was replaced. Restore the original folder before retrying.')
      if (existsSync(target))
        throw new Error(
          'Destination already exists; neither folder was changed. Choose another path.'
        )
      try {
        renameSync(source, target)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EXDEV')
          throw new Error(
            'These folders are on different filesystems. Move the folder manually, then use Update path.'
          )
        throw err
      }
    } else if (!existsSync(target)) {
      throw new Error('Neither relocation folder exists. Restore the folder before retrying.')
    }
    const actual = lstatSync(target)
    if (actual.dev !== plan.identity.dev || actual.ino !== plan.identity.ino)
      throw new Error(
        'Relocation folder was replaced. Restore the original folder before retrying.'
      )
    for (const repo of plan.repos) {
      const root = allowed(relocatedPath(repo.root, source, target))
      const worktrees = repo.worktrees
        .map((p) => allowed(relocatedPath(p, source, target)))
        .filter(existsSync)
      await git(root, ['worktree', 'repair', ...worktrees])
    }
    await opts.remap(plan.projectId, source, target)
    await opts.store().set(plan.projectId, target)
    unlinkSync(journal())
  }

  return {
    assertAvailable() {
      if (busy || existsSync(journal()))
        throw new Error('Project relocation is in progress. Retry when it finishes.')
    },
    async recover() {
      if (recovered) return
      if (busy) throw new Error('Project relocation is in progress. Retry when it finishes.')
      busy = true
      try {
        if (existsSync(journal())) {
          const plan = planSchema.parse(JSON.parse(readFileSync(journal(), 'utf8')))
          await opts.assertIdle(plan.projectId)
          await finish(plan)
        }
        recovered = true
      } finally {
        busy = false
      }
    },
    async move(
      projectId: string,
      sourcePath: string,
      path: string,
      mode: 'move' | 'update' = 'move'
    ) {
      if (busy) throw new Error('Project relocation is in progress. Retry when it finishes.')
      busy = true
      try {
        await opts.assertIdle(projectId)
        const current = opts.store().get(projectId)?.path ?? ''
        const target = allowed(path)
        // A lost RPC reply can be retried after the computer already committed.
        if (current === target && existsSync(target)) return { path: target }
        if (current !== (sourcePath ? resolve(sourcePath) : ''))
          throw new Error('Project folder changed. Reopen Relocate and try again.')
        if (mode === 'move' && !sourcePath) throw new Error('Project has no folder to move.')
        const source = sourcePath ? allowed(sourcePath) : ''
        if (target === source) return { path: source }
        if (mode === 'move') await opts.store().assertRelocatable?.(projectId, source)
        if (source && isWithinDirectory(target, source))
          throw new Error('Destination must be outside the current project folder.')
        if (mode === 'move' && existsSync(target))
          throw new Error('Destination already exists. Choose a new folder name.')
        const stat = lstatSync(mode === 'move' ? source : target)
        if (!stat.isDirectory()) throw new Error('Project path must be a directory.')
        if (!lstatSync(dirname(target)).isDirectory())
          throw new Error('Destination parent must exist.')
        const plan: Plan = {
          projectId,
          source,
          target,
          mode,
          identity: { dev: stat.dev, ino: stat.ino },
          repos: await repositories(mode === 'move' ? source : target, source || target)
        }
        // Validate every Git link BEFORE touching disk. External worktrees remain
        // in place, but their .git backlink must be repaired by this computer.
        for (const repo of plan.repos) {
          allowed(repo.root)
          for (const path of repo.worktrees) allowed(path)
        }
        writeFileSync(`${journal()}.tmp`, JSON.stringify(plan), { mode: 0o600 })
        renameSync(`${journal()}.tmp`, journal())
        try {
          await finish(plan)
        } catch (err) {
          // A pre-rename failure needs no recovery. After rename, retain the plan
          // and fence new work until recovery repairs Git and updates mappings.
          if (mode === 'move' && existsSync(source) && !existsSync(target)) unlinkSync(journal())
          else recovered = false
          throw err
        }
        return { path: target }
      } finally {
        busy = false
      }
    }
  }
}
