/**
 * Paged git text, routed (`worktrees.readGitText`). A computer that answers bounded
 * reads runs the op itself (spooled pages). An older computer only knows the
 * whole-text ops: the hub asks it for the whole text once and answers it as one
 * last page — the panel has one code path, no worse than before against an old
 * computer (one whole reply, the frame limit its backstop).
 *
 * @module worktrees/server/git-text-routing
 */
import type { SlayzoneDb } from '@slayzone/platform'
import { utf8ByteLength } from '@slayzone/platform/bounded-reads'
import type { GitOpInput } from '../shared/git-ops-contract'
import { GIT_TEXT_EXPIRED, gitTextSourceOf, type GitTextPage } from '../shared/git-text'
import { executeGitOp, gitComputerSupports } from './git-op-routing'
import type { WorktreesComputerTarget } from './worktrees-router-deps'

export async function readGitTextRouted(
  input: GitOpInput<'readGitText'> & { target?: WorktreesComputerTarget },
  db: SlayzoneDb
): Promise<GitTextPage> {
  if (await gitComputerSupports(input.target, 'boundedReads'))
    return executeGitOp('readGitText', input, false, db)
  // An older computer's answers are whole: there is never a next page to ask for.
  if (input.cursor !== null)
    throw new Error(`${GIT_TEXT_EXPIRED}: this computer answers whole texts; read it again`)
  const source = gitTextSourceOf(input)
  const { repoPath, target } = input
  let text: string
  switch (source.kind) {
    case 'fileDiff':
      text = await executeGitOp(
        'getFileDiff',
        {
          repoPath,
          filePath: source.filePath,
          staged: source.staged,
          ...(source.opts ? { opts: source.opts } : {}),
          target
        },
        false,
        db
      )
      break
    case 'untrackedDiff':
      text = await executeGitOp(
        'getUntrackedFileDiff',
        { repoPath, filePath: source.filePath, target },
        false,
        db
      )
      break
    case 'stashDiff':
      text = await executeGitOp(
        'getStashDiff',
        { repoPath, index: source.index, target },
        false,
        db
      )
      break
    case 'rangeFileDiff':
      throw new Error(
        'This computer cannot page a turn diff; update SlayZone on that computer to see it'
      )
  }
  return { text, cursor: null, totalBytes: utf8ByteLength(text) }
}
