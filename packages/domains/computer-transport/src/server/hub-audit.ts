/**
 * Which hub → computer calls the security audit log records (T-03), and the part of
 * their params that is safe to write.
 *
 * Every privileged act the hub performs on a computer — a pty or process spawned, a
 * file written, deleted or renamed, a git or `gh` command, the computer's path-jail
 * changed — leaves through ONE door, `HubComputerGateway.request`, which writes the
 * line. The acting user comes from the request context the tRPC/REST entry point set
 * (`runWithSecurityContext`); a call the hub makes on its own behalf has none.
 *
 * {@link HUB_CALL_AUDIT} classifies EVERY method in `HubToComputerMethods`, typed
 * exhaustively: a new method does not compile until someone decides whether it is
 * audited. `null` = not audited — a read, a stream, terminal input (content, and one
 * frame per keystroke), or bookkeeping.
 *
 * The detail picks ids, paths and program names only — never `args` (an agent's
 * prompt rides there), `env`, `stdin`, `data` or file `content`.
 *
 * @module computer/server/hub-audit
 */
import type { SecurityEventName } from '@slayzone/platform/security-log'
import type { HubToComputerMethods } from '../shared/frames'

type HubMethod = (typeof HubToComputerMethods)[keyof typeof HubToComputerMethods]
type Params = Record<string, unknown>

interface AuditRule {
  event: SecurityEventName
  detail: (p: Params) => Record<string, unknown>
}

/**
 * The program a spawn runs — `zsh` for `/bin/zsh` — never its arguments, and nothing
 * that is not a plain file name: a shell string's first word can be `TOKEN=…`.
 */
function programName(command: unknown): string | null {
  if (typeof command !== 'string') return null
  const first = command.trim().split(/\s+/)[0] ?? ''
  const base = first.split(/[\\/]/).pop() ?? ''
  return /^[A-Za-z0-9._+-]{1,64}$/.test(base) ? base : null
}

/** `gh pr create …` → `pr create`: leading subcommand words only, no flags or values. */
function ghSubcommand(args: unknown): string | null {
  if (!Array.isArray(args)) return null
  const words: string[] = []
  for (const a of args.slice(0, 2)) {
    if (typeof a !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(a)) break
    words.push(a)
  }
  return words.length > 0 ? words.join(' ') : null
}

const spawn: AuditRule['detail'] = (p) => ({
  sessionId: p.sessionId,
  projectId: p.projectId,
  program: programName(p.command)
})

export const HUB_CALL_AUDIT: Record<HubMethod, AuditRule | null> = {
  'pty.spawn': { event: 'computer.pty.spawn', detail: spawn },
  'pty.warmSpawn': {
    event: 'computer.pty.spawn',
    detail: (p) => ({ warmId: p.warmId, program: programName(p.command), warm: true })
  },
  'pty.kill': { event: 'computer.pty.kill', detail: (p) => ({ sessionId: p.sessionId }) },
  'pty.warmKill': { event: 'computer.pty.kill', detail: (p) => ({ warmId: p.warmId, warm: true }) },
  'pty.resize': null,
  'pty.write': null,
  'pty.getBufferSince': null,
  'pty.list': null,
  'pty.prioritize': null,
  'pty.backgroundJobs': null,
  'pty.runtimeCheck': null,
  'pty.warmAdopt': null,
  'pty.warmList': null,
  'proc.spawn': {
    event: 'computer.proc.spawn',
    detail: (p) => ({ ...spawn(p), shell: p.shell === true })
  },
  'proc.kill': { event: 'computer.proc.kill', detail: (p) => ({ sessionId: p.sessionId }) },
  'proc.write': null,
  'proc.getBufferSince': null,
  'proc.list': null,
  'fs.writeFile': {
    event: 'computer.fs.write',
    detail: (p) => ({ rootPath: p.rootPath, path: p.filePath })
  },
  'fs.createFile': {
    event: 'computer.fs.write',
    detail: (p) => ({ rootPath: p.rootPath, path: p.filePath })
  },
  'fs.createDir': {
    event: 'computer.fs.write',
    detail: (p) => ({ rootPath: p.rootPath, path: p.dirPath })
  },
  'fs.mkdir': { event: 'computer.fs.write', detail: (p) => ({ path: p.path }) },
  'fs.copyIn': {
    event: 'computer.fs.write',
    detail: (p) => ({ rootPath: p.rootPath, from: p.absoluteSrc, path: p.targetDir })
  },
  'fs.copy': {
    event: 'computer.fs.write',
    detail: (p) => ({ rootPath: p.rootPath, from: p.srcPath, path: p.destPath })
  },
  'fs.delete': {
    event: 'computer.fs.delete',
    detail: (p) => ({ rootPath: p.rootPath, path: p.targetPath })
  },
  'fs.removeDir': { event: 'computer.fs.delete', detail: (p) => ({ path: p.path }) },
  'fs.rename': {
    event: 'computer.fs.rename',
    detail: (p) => ({ rootPath: p.rootPath, from: p.oldPath, path: p.newPath })
  },
  'fs.pathExists': null,
  'fs.listRoots': null,
  'fs.listDir': null,
  'fs.readDir': null,
  'fs.readFile': null,
  'fs.gitStatus': null,
  'fs.searchFiles': null,
  'fs.listAllFiles': null,
  'fs.discoverRepos': null,
  'fs.watchStart': null,
  'fs.watchStop': null,
  'git.createWorktree': {
    event: 'computer.git',
    detail: (p) => ({ repoPath: p.repoPath, worktreePath: p.worktreePath, branch: p.branch })
  },
  'git.removeWorktree': {
    event: 'computer.git',
    detail: (p) => ({ repoPath: p.projectPath, worktreePath: p.worktreePath })
  },
  'git.runWorktreeSetupScript': {
    event: 'computer.git',
    detail: (p) => ({ repoPath: p.repoPath, worktreePath: p.worktreePath })
  },
  'git.copyIgnoredFiles': {
    event: 'computer.git',
    detail: (p) => ({ repoPath: p.repoPath, worktreePath: p.worktreePath })
  },
  'git.isGitRepo': null,
  'git.getCurrentBranch': null,
  'gh.exec': { event: 'computer.gh', detail: (p) => ({ subcommand: ghSubcommand(p.args) }) },
  'computer.setAllowedRoots': {
    event: 'computer.allowed_roots.set',
    detail: (p) => ({ roots: p.roots })
  },
  'computer.shutdown': { event: 'computer.shutdown', detail: (p) => ({ reason: p.reason }) },
  'project.resolvePath': null,
  'project.setPath': null,
  'project.forgetPath': null,
  'project.list': null,
  ping: null
}

/** The audit event for a hub → computer call, or null when the method is not audited. */
export function auditedHubCall(
  method: string,
  params: unknown
): { event: SecurityEventName; detail: Record<string, unknown> } | null {
  const rule = (HUB_CALL_AUDIT as Record<string, AuditRule | null | undefined>)[method]
  if (!rule) return null
  const p = params !== null && typeof params === 'object' ? (params as Params) : {}
  return { event: rule.event, detail: { method, ...rule.detail(p) } }
}
