/**
 * Cloning a project's repository onto this computer, and reading where a checkout
 * came from. Shared by the project folder setup (Project settings) and the task
 * move to another computer.
 *
 * @module computer/git-clone
 */
import { existsSync, mkdirSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { execCapture } from './handlers/exec'
import { judgePath } from './path-jail'

/** A clone source git accepts as a URL or path, never as an option or a command. */
export function assertCloneUrl(url: string): void {
  if (!url || url.startsWith('-') || url.includes('\0') || /^ext::/i.test(url))
    throw new Error('That repository address cannot be cloned')
}

/** The checkout's `origin` remote; null when it is not a repository or has none. */
export async function originOf(repo: string): Promise<string | null> {
  if (!existsSync(repo)) return null
  const result = await execCapture('git', ['-C', repo, 'remote', 'get-url', 'origin'])
  return result.status === 0 ? result.stdout.trim() || null : null
}

/**
 * Clone `url` into `target` (judged against the allowed roots). Refused when the
 * folder already holds anything; never waits on a credential prompt.
 */
export async function cloneInto(
  url: string,
  target: string,
  allowedRoots: readonly string[]
): Promise<string> {
  assertCloneUrl(url)
  const path = judgePath(target, allowedRoots)
  if (existsSync(path) && (await readdir(path)).length > 0)
    throw new Error(
      `${path} is not empty. Choose an empty folder, or check the repository out there yourself.`
    )
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  const result = await execCapture(
    'git',
    ['-c', 'protocol.ext.allow=never', 'clone', '--', url, path],
    {
      cwd: parent,
      timeoutMs: 30 * 60 * 1000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }
    }
  )
  if (result.status !== 0)
    throw new Error(`Could not clone ${url}: ${result.stderr.trim() || 'git clone failed'}`)
  return path
}
