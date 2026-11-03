import type {
  GhPullRequest,
  GhPrComment,
  GhPrTimelineEvent,
  CreatePrInput,
  CreatePrResult,
  MergePrInput,
  EditPrCommentInput
} from '../shared/types'
import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'

const GH_PR_JSON_FIELDS =
  'number,title,body,url,state,headRefName,baseRefName,isCrossRepository,isDraft,author,createdAt,reviewDecision,statusCheckRollup'

/**
 * Where `gh` actually runs.
 *
 * Injectable because `gh` authenticates as whoever owns the machine it runs on:
 * executing it here meant the PR panel spoke as the HUB while the agent pushed as
 * the COMPUTER — two identities for one repository, only one of them holding
 * credentials. The hub injects a routed executor so the process lands on the
 * computer; the eleven typed functions below, and all their JSON parsing, are
 * untouched.
 *
 * ONE seam rather than eleven routed functions: this is already the single
 * chokepoint every one of them goes through.
 */
export interface GhExecutor {
  (
    args: string[],
    opts: { cwd?: string; timeout?: number; stdin?: string }
  ): Promise<{ status: number | null; stdout: string; stderr: string }>
}

/** This machine has no `gh` on its login-shell PATH. */
export class GhNotFoundError extends Error {
  constructor() {
    super('gh CLI not found')
    this.name = 'GhNotFoundError'
  }
}

/** No executor wired: `gh` has nowhere to run — the hub never runs it itself. */
const noComputer: GhExecutor = async () => refuseNoComputer({ op: 'gh' })

let ghExecutor: GhExecutor = noComputer

/**
 * Point every gh call at a computer. Called by the hub composition once the computer
 * gateway exists; null = none ("connect a computer").
 */
export function setGhExecutor(executor: GhExecutor | null): void {
  ghExecutor = executor ?? noComputer
}

async function spawnGh(
  args: string[],
  opts: { cwd?: string; timeout?: number; stdin?: string } = {}
) {
  return ghExecutor(args, opts)
}

interface RawGhPr {
  number: number
  title: string
  body: string
  url: string
  state: string
  headRefName: string
  baseRefName: string
  isCrossRepository?: boolean
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
    const states = pr.statusCheckRollup.map((c) => c.state)
    if (states.some((s) => s === 'FAILURE' || s === 'ERROR')) checkStatus = 'FAILURE'
    else if (states.some((s) => s === 'PENDING' || s === 'EXPECTED')) checkStatus = 'PENDING'
    else if (states.length > 0) checkStatus = 'SUCCESS'
  } else if (typeof pr.statusCheckRollup === 'string' && pr.statusCheckRollup) {
    const s = pr.statusCheckRollup.toUpperCase()
    if (s === 'FAILURE' || s === 'ERROR') checkStatus = 'FAILURE'
    else if (s === 'PENDING' || s === 'EXPECTED') checkStatus = 'PENDING'
    else if (s === 'SUCCESS') checkStatus = 'SUCCESS'
  }

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    url: pr.url,
    state: pr.state as GhPullRequest['state'],
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    isCrossRepository: pr.isCrossRepository ?? false,
    isDraft: pr.isDraft,
    author: pr.author.login,
    createdAt: pr.createdAt,
    reviewDecision: (pr.reviewDecision as GhPullRequest['reviewDecision']) || '',
    statusCheckRollup: checkStatus
  }
}

/**
 * Whether `gh` exists on the machine that would run it for `repoPath` — through the
 * same executor every other gh call takes, so a checkout on a computer is answered by
 * that computer, not by the hub. A computer without gh reports a spawn failure
 * (status null); this machine without gh throws {@link GhNotFoundError}. A refused
 * local exec (processes off, no computer) still propagates.
 */
export async function checkGhInstalled(repoPath: string): Promise<boolean> {
  try {
    const result = await spawnGh(['--version'], { cwd: repoPath })
    return result.status === 0
  } catch (err) {
    if (err instanceof GhNotFoundError) return false
    throw err
  }
}

export async function listOpenPrs(repoPath: string): Promise<GhPullRequest[]> {
  const result = await spawnGh(
    ['pr', 'list', '--json', GH_PR_JSON_FIELDS, '--state', 'open', '--limit', '50'],
    { cwd: repoPath }
  )

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || ''
    if (stderr.includes('no git remotes found')) return []
    throw new Error(`gh pr list failed: ${stderr}`)
  }
  const parsed = JSON.parse(result.stdout) as RawGhPr[]
  return parsed.map(parseGhPr)
}

export async function getPrByUrl(repoPath: string, url: string): Promise<GhPullRequest | null> {
  const match = url.match(/\/pull\/(\d+)/)
  if (!match) return null

  const result = await spawnGh(['pr', 'view', match[1], '--json', GH_PR_JSON_FIELDS], {
    cwd: repoPath
  })

  if (result.status !== 0) return null
  return parseGhPr(JSON.parse(result.stdout))
}

/**
 * gh's answers that mean "this checkout has no PR" — as opposed to "gh couldn't
 * find out" (auth, network, rate limit), which must throw so the client keeps the
 * last PR it showed instead of blinking it away.
 */
const NO_PR_FOR_CHECKOUT = [
  /no pull requests found/i,
  // Detached HEAD / not on a branch.
  /could not determine current branch/i,
  /not on any branch/i,
  // Not a GitHub repo at all.
  /no git remotes found/i,
  /none of the git remotes .* point to a known GitHub host/i
]

/**
 * The PR for whatever branch is checked out at `checkoutPath`, resolved by gh itself
 * (`gh pr view` with no argument). gh derives the head from the branch's push
 * target (`@{push}`), so a PR opened from a fork resolves to `owner:branch`
 * rather than matching any same-named branch, and when one branch has several PRs
 * it prefers the open one. A manually linked `pr_url` always overrides this.
 *
 * `branch` is not passed to gh (that would lose the fork resolution above); it
 * keys the client cache so a branch switch can never be served the old PR.
 *
 * Null = no PR. Throws when gh failed for any other reason.
 */
export async function getPrForCheckout(
  checkoutPath: string,
  _branch: string
): Promise<GhPullRequest | null> {
  const result = await spawnGh(['pr', 'view', '--json', GH_PR_JSON_FIELDS], { cwd: checkoutPath })
  if (result.status === 0) return parseGhPr(JSON.parse(result.stdout))
  const stderr = result.stderr?.trim() ?? ''
  if (NO_PR_FOR_CHECKOUT.some((re) => re.test(stderr))) return null
  // Logged on its own event so a gh release that rewords a "no PR" answer shows up
  // here (one line to add above) rather than as a PR that silently never appears.
  recordDiagnosticEvent({
    level: 'warn',
    source: 'gh',
    event: 'gh.pr_for_checkout_unrecognized',
    message: stderr || `gh pr view exited ${result.status ?? 'without starting'}`,
    payload: { cwd: checkoutPath, exitCode: result.status }
  })
  throw new Error(`gh pr view failed: ${stderr || `exit ${result.status ?? 'spawn failure'}`}`)
}

/**
 * `ensurePushed`: publish the branch first — the routed `ensureBranchPushed` op (it
 * runs on the checkout's computer).
 */
export async function createPr(
  input: CreatePrInput,
  ensurePushed: (repoPath: string) => Promise<void>
): Promise<CreatePrResult> {
  await ensurePushed(input.repoPath)

  const args = [
    'pr',
    'create',
    '--title',
    input.title,
    '--body',
    input.body,
    '--base',
    input.baseBranch
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

export async function getPrComments(
  repoPath: string,
  prNumber: number
): Promise<GhPrTimelineEvent[]> {
  // Resolve repo slug once, shared by all API calls
  let slug: { owner: string; repo: string } | null = null
  try {
    slug = await getRepoOwnerAndName(repoPath)
  } catch {
    /* ignore */
  }

  const apiCalls: [
    Promise<{ status: number | null; stdout: string; stderr: string }>,
    Promise<{ status: number | null; stdout: string; stderr: string }>,
    Promise<{ status: number | null; stdout: string; stderr: string }>
  ] = [
    spawnGh(['pr', 'view', String(prNumber), '--json', 'comments,reviews,commits'], {
      cwd: repoPath
    }),
    // Review file comments + review numeric IDs (for matching)
    slug
      ? spawnGh(
          [
            'api',
            `repos/${slug.owner}/${slug.repo}/pulls/${prNumber}/comments`,
            '--jq',
            '[.[] | {path, review_id: .pull_request_review_id}]'
          ],
          { cwd: repoPath }
        )
      : Promise.resolve({ status: 1, stdout: '', stderr: '' }),
    slug
      ? spawnGh(
          [
            'api',
            `repos/${slug.owner}/${slug.repo}/pulls/${prNumber}/reviews`,
            '--jq',
            '[.[] | {id, submitted_at}]'
          ],
          { cwd: repoPath }
        )
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
      const fileComments = JSON.parse(reviewFilesResult.stdout) as Array<{
        path: string
        review_id: number
      }>
      for (const fc of fileComments) {
        const files = reviewFileMap.get(fc.review_id) ?? []
        if (!files.includes(fc.path)) files.push(fc.path)
        reviewFileMap.set(fc.review_id, files)
      }
    } catch {
      /* ignore parse errors */
    }
  }

  // Map review submittedAt → numeric REST ID for matching with file comments
  let reviewIdBySubmittedAt = new Map<string, number>()
  if (restReviewsResult.status === 0 && restReviewsResult.stdout) {
    try {
      const parsed = JSON.parse(restReviewsResult.stdout) as Array<{
        id: number
        submitted_at: string
      }>
      reviewIdBySubmittedAt = new Map(parsed.map((r) => [r.submitted_at, r.id]))
    } catch {
      /* ignore */
    }
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

export async function addPrComment(
  repoPath: string,
  prNumber: number,
  body: string
): Promise<void> {
  const result = await spawnGh(['pr', 'comment', String(prNumber), '--body', body], {
    cwd: repoPath,
    timeout: 15000
  })

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
  const result = await spawnGh(
    [
      'api',
      `repos/${owner}/${repo}/issues/comments/${input.commentId}`,
      '-X',
      'PATCH',
      '-f',
      `body=${input.body}`
    ],
    { cwd: input.repoPath, timeout: 15000 }
  )

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'Unknown error'
    throw new Error(`Edit comment failed: ${stderr}`)
  }
}
