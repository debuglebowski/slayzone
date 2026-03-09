import { whichBinary, resolveUserShell, getShellStartupArgs } from '@slayzone/terminal/main'
import type { GhPullRequest, GhPrComment, GhPrTimelineEvent, CreatePrInput, CreatePrResult, MergePrInput, EditPrCommentInput } from '../shared/types'
import { execAsync, execGit } from './exec-async'

const GH_PR_JSON_FIELDS = 'number,title,body,url,state,headRefName,baseRefName,isDraft,author,createdAt,reviewDecision,statusCheckRollup'

// Cache resolved gh path
let ghPath: string | null | undefined

async function resolveGhPath(): Promise<string | null> {
  if (ghPath !== undefined) return ghPath
  ghPath = await whichBinary('gh')
  return ghPath
}

/** Run gh with the user's shell environment so PATH is correct. */
async function spawnGh(args: string[], opts: { cwd?: string; timeout?: number } = {}) {
  if (!ghPath) throw new Error('gh CLI not found')

  const shell = resolveUserShell()
  const shellArgs = getShellStartupArgs(shell)
  const cmd = [ghPath, ...args].map(a => `'${a.replace(/'/g, `'"'"'`)}'`).join(' ')

  return execAsync(shell, [...shellArgs, '-c', cmd], { ...opts, source: 'gh' })
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

export async function hasGithubRemote(repoPath: string): Promise<boolean> {
  try {
    const output = await execGit(['remote', '-v'], { cwd: repoPath })
    return /github\.com/i.test(output)
  } catch {
    return false
  }
}

async function ensureBranchPushed(repoPath: string): Promise<void> {
  try {
    await execGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: repoPath })
    return // upstream exists
  } catch {
    // no upstream — push
  }

  const branchOutput = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath })
  const branch = branchOutput.trim()

  const push = await execAsync('git', ['push', '-u', 'origin', branch], { cwd: repoPath, timeout: 30000 })
  if (push.status !== 0) {
    const stderr = push.stderr?.trim() || 'Unknown error'
    throw new Error(`Failed to push branch: ${stderr}`)
  }
}

export async function listOpenPrs(repoPath: string): Promise<GhPullRequest[]> {
  const result = await spawnGh([
    'pr', 'list',
    '--json', GH_PR_JSON_FIELDS,
    '--state', 'open',
    '--limit', '50'
  ], { cwd: repoPath })

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || ''
    throw new Error(`gh pr list failed: ${stderr}`)
  }
  const parsed = JSON.parse(result.stdout) as RawGhPr[]
  return parsed.map(parseGhPr)
}

export async function getPrByUrl(repoPath: string, url: string): Promise<GhPullRequest | null> {
  const match = url.match(/\/pull\/(\d+)/)
  if (!match) return null

  const result = await spawnGh([
    'pr', 'view', match[1],
    '--json', GH_PR_JSON_FIELDS
  ], { cwd: repoPath })

  if (result.status !== 0) return null
  return parseGhPr(JSON.parse(result.stdout))
}

export async function createPr(input: CreatePrInput): Promise<CreatePrResult> {
  await ensureBranchPushed(input.repoPath)

  const args = [
    'pr', 'create',
    '--title', input.title,
    '--body', input.body,
    '--base', input.baseBranch
  ]
  if (input.draft) args.push('--draft')

  const result = await spawnGh(args, { cwd: input.repoPath, timeout: 30000 })

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'Unknown error'
    throw new Error(`gh pr create failed: ${stderr}`)
  }

  const url = result.stdout.trim()
  const match = url.match(/\/pull\/(\d+)/)
  const number = match ? parseInt(match[1], 10) : 0

  return { url, number }
}

export async function getPrComments(repoPath: string, prNumber: number): Promise<GhPrTimelineEvent[]> {
  // Resolve repo slug once, shared by all API calls
  let slug: { owner: string; repo: string } | null = null
  try { slug = await getRepoOwnerAndName(repoPath) } catch { /* ignore */ }

  const apiCalls: [
    Promise<{ status: number | null; stdout: string; stderr: string }>,
    Promise<{ status: number | null; stdout: string; stderr: string }>,
    Promise<{ status: number | null; stdout: string; stderr: string }>
  ] = [
    spawnGh(['pr', 'view', String(prNumber), '--json', 'comments,reviews,commits'], { cwd: repoPath }),
    // Review file comments + review numeric IDs (for matching)
    slug
      ? spawnGh(['api', `repos/${slug.owner}/${slug.repo}/pulls/${prNumber}/comments`,
          '--jq', '[.[] | {path, review_id: .pull_request_review_id}]'], { cwd: repoPath })
      : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
    slug
      ? spawnGh(['api', `repos/${slug.owner}/${slug.repo}/pulls/${prNumber}/reviews`,
          '--jq', '[.[] | {id, submitted_at}]'], { cwd: repoPath })
      : Promise.resolve({ status: 1, stdout: '', stderr: '' })
  ]

  const [result, reviewFilesResult, restReviewsResult] = await Promise.all(apiCalls)

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
      submittedAt: string
    }>
    commits: Array<{
      oid: string
      messageHeadline: string
      committedDate: string
      authors: Array<{ login?: string; name?: string }>
    }>
  }

  // Build review_id → unique file paths map
  const reviewFileMap = new Map<number, string[]>()
  if (reviewFilesResult.status === 0 && reviewFilesResult.stdout) {
    try {
      const fileComments = JSON.parse(reviewFilesResult.stdout) as Array<{ path: string; review_id: number }>
      for (const fc of fileComments) {
        const files = reviewFileMap.get(fc.review_id) ?? []
        if (!files.includes(fc.path)) files.push(fc.path)
        reviewFileMap.set(fc.review_id, files)
      }
    } catch { /* ignore parse errors */ }
  }

  // Map review submittedAt → numeric REST ID for matching with file comments
  let reviewIdBySubmittedAt = new Map<string, number>()
  if (restReviewsResult.status === 0 && restReviewsResult.stdout) {
    try {
      const parsed = JSON.parse(restReviewsResult.stdout) as Array<{ id: number; submitted_at: string }>
      reviewIdBySubmittedAt = new Map(parsed.map(r => [r.submitted_at, r.id]))
    } catch { /* ignore */ }
  }

  const events: GhPrTimelineEvent[] = []

  for (const c of data.comments ?? []) {
    events.push({
      id: c.id,
      author: c.author.login,
      body: c.body,
      createdAt: c.createdAt,
      type: 'comment'
    })
  }

  for (const r of data.reviews ?? []) {
    const numericId = reviewIdBySubmittedAt.get(r.submittedAt)
    const reviewFiles = numericId ? reviewFileMap.get(numericId) : undefined

    if (!r.body?.trim()) {
      events.push({
        id: r.id,
        author: r.author.login,
        body: '',
        createdAt: r.submittedAt,
        type: 'review',
        reviewState: r.state as GhPrComment['reviewState'],
        reviewFiles
      })
      continue
    }
    events.push({
      id: r.id,
      author: r.author.login,
      body: r.body,
      createdAt: r.submittedAt,
      type: 'review',
      reviewState: r.state as GhPrComment['reviewState'],
      reviewFiles
    })
  }

  for (const c of data.commits ?? []) {
    const author = c.authors?.[0]
    events.push({
      type: 'commit',
      oid: c.oid,
      messageHeadline: c.messageHeadline,
      author: author?.login || author?.name || 'unknown',
      createdAt: c.committedDate
    })
  }

  // Sort chronologically
  events.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  return events
}

export async function addPrComment(repoPath: string, prNumber: number, body: string): Promise<void> {
  const result = await spawnGh([
    'pr', 'comment', String(prNumber),
    '--body', body
  ], { cwd: repoPath, timeout: 15000 })

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'Unknown error'
    throw new Error(`gh pr comment failed: ${stderr}`)
  }
}

export async function mergePr(input: MergePrInput): Promise<void> {
  const args = ['pr', 'merge', String(input.prNumber), `--${input.strategy}`]
  if (input.deleteBranch) args.push('--delete-branch')
  if (input.auto) args.push('--auto')

  const result = await spawnGh(args, { cwd: input.repoPath, timeout: 30000 })

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'Unknown error'
    throw new Error(`gh pr merge failed: ${stderr}`)
  }
}

export async function getPrDiff(repoPath: string, prNumber: number): Promise<string> {
  const result = await spawnGh(['pr', 'diff', String(prNumber)], { cwd: repoPath, timeout: 30000 })

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'Unknown error'
    throw new Error(`gh pr diff failed: ${stderr}`)
  }
  return result.stdout
}

// Cache gh user per session
let cachedGhUser: string | null = null

export async function getGhUser(repoPath: string): Promise<string> {
  if (cachedGhUser) return cachedGhUser
  const result = await spawnGh(['api', 'user', '--jq', '.login'], { cwd: repoPath })
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'Unknown error'
    throw new Error(`gh api user failed: ${stderr}`)
  }
  cachedGhUser = result.stdout.trim()
  return cachedGhUser
}

async function getRepoOwnerAndName(repoPath: string): Promise<{ owner: string; repo: string }> {
  const result = await spawnGh(['repo', 'view', '--json', 'owner,name'], { cwd: repoPath })
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'Unknown error'
    throw new Error(`gh repo view failed: ${stderr}`)
  }
  const data = JSON.parse(result.stdout) as { owner: { login: string }; name: string }
  return { owner: data.owner.login, repo: data.name }
}

export async function editPrComment(input: EditPrCommentInput): Promise<void> {
  const { owner, repo } = await getRepoOwnerAndName(input.repoPath)
  const result = await spawnGh([
    'api', `repos/${owner}/${repo}/issues/comments/${input.commentId}`,
    '-X', 'PATCH',
    '-f', `body=${input.body}`
  ], { cwd: input.repoPath, timeout: 15000 })

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'Unknown error'
    throw new Error(`Edit comment failed: ${stderr}`)
  }
}
