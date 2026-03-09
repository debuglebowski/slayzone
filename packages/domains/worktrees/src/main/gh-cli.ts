import { spawnSync, execSync } from 'child_process'
import { whichBinary, resolveUserShell, getShellStartupArgs } from '@slayzone/terminal/main'
import type { GhPullRequest, GhPrComment, CreatePrInput, CreatePrResult, MergePrInput, EditPrCommentInput } from '../shared/types'

const GH_PR_JSON_FIELDS = 'number,title,body,url,state,headRefName,baseRefName,isDraft,author,createdAt,reviewDecision,statusCheckRollup'

// Cache resolved gh path
let ghPath: string | null | undefined

async function resolveGhPath(): Promise<string | null> {
  if (ghPath !== undefined) return ghPath
  ghPath = await whichBinary('gh')
  return ghPath
}

/** Run gh with the user's shell environment so PATH is correct. */
function spawnGh(args: string[], opts: { cwd?: string; timeout?: number } = {}) {
  if (!ghPath) throw new Error('gh CLI not found')

  const shell = resolveUserShell()
  const shellArgs = getShellStartupArgs(shell)
  const cmd = [ghPath, ...args].map(a => `'${a.replace(/'/g, `'"'"'`)}'`).join(' ')

  return spawnSync(shell, [...shellArgs, '-c', cmd], {
    cwd: opts.cwd,
    encoding: 'utf-8' as const,
    timeout: opts.timeout ?? 15000
  })
}

interface RawGhPr {
  number: number
  title: string
  body: string
  url: string
  state: string
  headRefName: string
  baseRefName: string
  isDraft: boolean
  author: { login: string }
  createdAt: string
  reviewDecision?: string
  statusCheckRollup?: Array<{ state: string }> | string
}

function parseGhPr(pr: RawGhPr): GhPullRequest {
  // statusCheckRollup from gh can be an array of check objects or a string
  let checkStatus: GhPullRequest['statusCheckRollup'] = ''
  if (Array.isArray(pr.statusCheckRollup)) {
    const states = pr.statusCheckRollup.map(c => c.state)
    if (states.some(s => s === 'FAILURE' || s === 'ERROR')) checkStatus = 'FAILURE'
    else if (states.some(s => s === 'PENDING' || s === 'EXPECTED')) checkStatus = 'PENDING'
    else if (states.length > 0) checkStatus = 'SUCCESS'
  }

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    url: pr.url,
    state: pr.state as GhPullRequest['state'],
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    isDraft: pr.isDraft,
    author: pr.author.login,
    createdAt: pr.createdAt,
    reviewDecision: (pr.reviewDecision as GhPullRequest['reviewDecision']) || '',
    statusCheckRollup: checkStatus
  }
}

export async function checkGhInstalled(): Promise<boolean> {
  const path = await resolveGhPath()
  return path !== null
}

export function hasGithubRemote(repoPath: string): boolean {
  try {
    const output = execSync('git remote -v', { cwd: repoPath, encoding: 'utf-8', timeout: 5000 })
    return /github\.com/i.test(output)
  } catch {
    return false
  }
}

function ensureBranchPushed(repoPath: string): void {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
    cwd: repoPath,
    encoding: 'utf-8',
    timeout: 5000
  })
  if (result.status === 0) return

  const branch = execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: repoPath,
    encoding: 'utf-8',
    timeout: 5000
  }).trim()

  const push = spawnSync('git', ['push', '-u', 'origin', branch], {
    cwd: repoPath,
    encoding: 'utf-8',
    timeout: 30000
  })
  if (push.status !== 0) {
    const stderr = push.stderr?.toString().trim() || 'Unknown error'
    throw new Error(`Failed to push branch: ${stderr}`)
  }
}

export function listOpenPrs(repoPath: string): GhPullRequest[] {
  const result = spawnGh([
    'pr', 'list',
    '--json', GH_PR_JSON_FIELDS,
    '--state', 'open',
    '--limit', '50'
  ], { cwd: repoPath })

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || ''
    throw new Error(`gh pr list failed: ${stderr}`)
  }
  const parsed = JSON.parse(result.stdout) as RawGhPr[]
  return parsed.map(parseGhPr)
}

export function getPrByUrl(repoPath: string, url: string): GhPullRequest | null {
  const match = url.match(/\/pull\/(\d+)/)
  if (!match) return null

  const result = spawnGh([
    'pr', 'view', match[1],
    '--json', GH_PR_JSON_FIELDS
  ], { cwd: repoPath })

  if (result.status !== 0) return null
  return parseGhPr(JSON.parse(result.stdout))
}

export function createPr(input: CreatePrInput): CreatePrResult {
  ensureBranchPushed(input.repoPath)

  const args = [
    'pr', 'create',
    '--title', input.title,
    '--body', input.body,
    '--base', input.baseBranch
  ]
  if (input.draft) args.push('--draft')

  const result = spawnGh(args, { cwd: input.repoPath, timeout: 30000 })

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || 'Unknown error'
    throw new Error(`gh pr create failed: ${stderr}`)
  }

  const url = result.stdout.trim()
  const match = url.match(/\/pull\/(\d+)/)
  const number = match ? parseInt(match[1], 10) : 0

  return { url, number }
}

export function getPrComments(repoPath: string, prNumber: number): GhPrComment[] {
  const result = spawnGh([
    'pr', 'view', String(prNumber),
    '--json', 'comments,reviews'
  ], { cwd: repoPath })

  if (result.status !== 0) return []

  const data = JSON.parse(result.stdout) as {
    comments: Array<{
      id: string
      author: { login: string }
      body: string
      createdAt: string
    }>
    reviews: Array<{
      id: string
      author: { login: string }
      body: string
      state: string
      createdAt: string
    }>
  }

  const comments: GhPrComment[] = []

  for (const c of data.comments ?? []) {
    comments.push({
      id: c.id,
      author: c.author.login,
      body: c.body,
      createdAt: c.createdAt,
      type: 'comment'
    })
  }

  for (const r of data.reviews ?? []) {
    // Skip reviews with no body (just approval clicks with no text)
    if (!r.body?.trim()) {
      // Still show approval/rejection as a status-only entry
      comments.push({
        id: r.id,
        author: r.author.login,
        body: '',
        createdAt: r.createdAt,
        type: 'review',
        reviewState: r.state as GhPrComment['reviewState']
      })
      continue
    }
    comments.push({
      id: r.id,
      author: r.author.login,
      body: r.body,
      createdAt: r.createdAt,
      type: 'review',
      reviewState: r.state as GhPrComment['reviewState']
    })
  }

  // Sort chronologically
  comments.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  return comments
}

export function addPrComment(repoPath: string, prNumber: number, body: string): void {
  const result = spawnGh([
    'pr', 'comment', String(prNumber),
    '--body', body
  ], { cwd: repoPath, timeout: 15000 })

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || 'Unknown error'
    throw new Error(`gh pr comment failed: ${stderr}`)
  }
}

export function mergePr(input: MergePrInput): void {
  const args = ['pr', 'merge', String(input.prNumber), `--${input.strategy}`]
  if (input.deleteBranch) args.push('--delete-branch')
  if (input.auto) args.push('--auto')

  const result = spawnGh(args, { cwd: input.repoPath, timeout: 30000 })

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || 'Unknown error'
    throw new Error(`gh pr merge failed: ${stderr}`)
  }
}

export function getPrDiff(repoPath: string, prNumber: number): string {
  const result = spawnGh(['pr', 'diff', String(prNumber)], { cwd: repoPath, timeout: 30000 })

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || 'Unknown error'
    throw new Error(`gh pr diff failed: ${stderr}`)
  }
  return result.stdout
}

// Cache gh user per session
let cachedGhUser: string | null = null

export function getGhUser(repoPath: string): string {
  if (cachedGhUser) return cachedGhUser
  const result = spawnGh(['api', 'user', '--jq', '.login'], { cwd: repoPath })
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || 'Unknown error'
    throw new Error(`gh api user failed: ${stderr}`)
  }
  cachedGhUser = result.stdout.trim()
  return cachedGhUser
}

function getRepoOwnerAndName(repoPath: string): { owner: string; repo: string } {
  const result = spawnGh(['repo', 'view', '--json', 'owner,name'], { cwd: repoPath })
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || 'Unknown error'
    throw new Error(`gh repo view failed: ${stderr}`)
  }
  const data = JSON.parse(result.stdout) as { owner: { login: string }; name: string }
  return { owner: data.owner.login, repo: data.name }
}

export function editPrComment(input: EditPrCommentInput): void {
  const { owner, repo } = getRepoOwnerAndName(input.repoPath)
  const result = spawnGh([
    'api', `repos/${owner}/${repo}/issues/comments/${input.commentId}`,
    '-X', 'PATCH',
    '-f', `body=${input.body}`
  ], { cwd: input.repoPath, timeout: 15000 })

  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim() || 'Unknown error'
    throw new Error(`Edit comment failed: ${stderr}`)
  }
}
