/**
 * getPrForCheckout — branch → PR resolution delegated to `gh pr view` (issue #94) —
 * and checkGhInstalled, which must ask the same (routed) executor.
 *
 * Run with: pnpm exec vitest run --config packages/apps/app/vitest.config.ts \
 *   packages/domains/worktrees/src/server/gh-pr-for-checkout.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const diagnostics = vi.hoisted(() => ({
  events: [] as Array<{ event: string; message: string }>
}))
vi.mock('@slayzone/diagnostics/server', () => ({
  recordDiagnosticEvent: (e: { event: string; message: string }) => diagnostics.events.push(e)
}))

const { checkGhInstalled, getPrForCheckout, setGhExecutor } = await import('./gh-cli')
type GhExecutor = import('./gh-cli').GhExecutor

const rawPr = {
  number: 42,
  title: 'Add thing',
  body: '',
  url: 'https://github.com/o/r/pull/42',
  state: 'OPEN',
  headRefName: 'feature',
  baseRefName: 'main',
  isDraft: false,
  author: { login: 'me' },
  createdAt: '2026-10-27T00:00:00Z',
  statusCheckRollup: [{ state: 'SUCCESS' }]
}

function fakeGh(result: { status: number | null; stdout: string; stderr?: string }) {
  const calls: Array<{ args: string[]; cwd?: string }> = []
  const exec: GhExecutor = async (args, opts) => {
    calls.push({ args, cwd: opts.cwd })
    return { stderr: '', ...result }
  }
  setGhExecutor(exec)
  return calls
}

afterEach(() => {
  setGhExecutor(null)
  diagnostics.events.length = 0
})

describe('getPrForCheckout', () => {
  it('asks gh for the checked-out branch (no PR arg) in the checkout dir', async () => {
    const calls = fakeGh({ status: 0, stdout: JSON.stringify(rawPr) })
    const pr = await getPrForCheckout('/wt/feature', 'feature')
    expect(calls).toHaveLength(1)
    expect(calls[0].cwd).toBe('/wt/feature')
    // No positional selector: gh then derives the head from the branch's
    // push target (`@{push}`), which is what makes fork PRs resolve correctly.
    expect(calls[0].args.slice(0, 3)).toEqual(['pr', 'view', '--json'])
    expect(calls[0].args).toHaveLength(4)
    expect(pr).toMatchObject({
      number: 42,
      headRefName: 'feature',
      statusCheckRollup: 'SUCCESS'
    })
  })

  it('is null when the checkout has no PR: none found, detached HEAD, not a GitHub repo', async () => {
    for (const stderr of [
      'no pull requests found for branch "feature"',
      'could not determine current branch: failed to run git: not on any branch',
      'no git remotes found',
      'none of the git remotes configured for this repository point to a known GitHub host.'
    ]) {
      fakeGh({ status: 1, stdout: '', stderr })
      expect(await getPrForCheckout('/wt/feature', 'feature')).toBeNull()
    }
  })

  it('throws when gh could not find out (auth, network, missing on the computer)', async () => {
    // Throwing — not null — is what lets the client keep the last PR it showed.
    for (const result of [
      {
        status: 4,
        stderr: 'To get started with GitHub CLI, please run:  gh auth login'
      },
      { status: 1, stderr: 'error connecting to api.github.com' },
      { status: null, stderr: '' }
    ]) {
      fakeGh({ ...result, stdout: '' })
      await expect(getPrForCheckout('/wt/feature', 'feature')).rejects.toThrow(/gh pr view failed/)
    }
    // Each unrecognized answer is logged, so a reworded "no PR" message is visible.
    expect(diagnostics.events.map((e) => e.event)).toEqual(
      Array(3).fill('gh.pr_for_checkout_unrecognized')
    )
  })

  it('logs nothing for a recognized "no PR" answer', async () => {
    fakeGh({
      status: 1,
      stdout: '',
      stderr: 'no pull requests found for branch "x"'
    })
    await getPrForCheckout('/wt/feature', 'feature')
    expect(diagnostics.events).toEqual([])
  })
})

describe('checkGhInstalled', () => {
  it('asks the executor for the checkout (so a computer answers for its own gh)', async () => {
    const calls = fakeGh({ status: 0, stdout: 'gh version 2.100.0' })
    expect(await checkGhInstalled('/wt/feature')).toBe(true)
    expect(calls).toEqual([{ args: ['--version'], cwd: '/wt/feature' }])
  })

  it('is false when the computer cannot spawn gh', async () => {
    fakeGh({ status: null, stdout: '' })
    expect(await checkGhInstalled('/wt/feature')).toBe(false)
  })

  it('propagates executor failures other than gh-not-found (e.g. a refusal)', async () => {
    setGhExecutor(async () => {
      throw new Error('refused')
    })
    await expect(checkGhInstalled('/wt/feature')).rejects.toThrow('refused')
  })
})
