/**
 * Spawn-free on purpose: the hub reaches this through git-snapshot (whose git runner
 * refuses on a switched-off hub), so it must not pull in workspace-capture's own
 * child_process runner (check-hub-exec-imports).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Runs one git command in the workspace with an env overlay. */
export type WorkspaceTreeGit = (
  args: string[],
  env?: Record<string, string>
) => Promise<{ text: string }>

/** Shared by legacy turn snapshots and chat observations; the user's index is never selected. */
export async function writeWorkspaceTree(
  git: WorkspaceTreeGit,
  head: string | null
): Promise<string> {
  const temp = await mkdtemp(join(tmpdir(), 'slayzone-workspace-'))
  try {
    const env = { GIT_INDEX_FILE: join(temp, 'index') }
    await git(['read-tree', ...(head ? [head] : ['--empty'])], env)
    await git(['add', '-A'], env)
    const tree = (await git(['write-tree'], env)).text.trim()
    if (!tree) throw new Error('Could not write workspace tree')
    return tree
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
