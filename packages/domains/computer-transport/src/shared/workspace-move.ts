import { z } from 'zod'

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
export const workspaceEntrySchema = z.object({
  path: z
    .string()
    .min(1)
    .max(10000)
    .refine(
      (p) =>
        !p.includes('\\') &&
        !p.includes('\0') &&
        !p.startsWith('/') &&
        p.split('/').every((s) => s !== '..' && s !== '.' && s !== '')
    ),
  type: z.enum(['file', 'directory', 'symlink']),
  size: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  hash: z.string(),
  link: z.string().optional()
})
export const workspaceManifestSchema = z.object({
  roots: z
    .array(
      z.object({
        key: z.enum(['worktree', 'base']),
        git: z.boolean(),
        head: z.string().optional(),
        branch: z.string().optional(),
        sameAs: z.literal('worktree').optional()
      })
    )
    .max(2),
  entries: z.array(workspaceEntrySchema).max(1_000_000),
  totalBytes: z.number().int().nonnegative()
})
export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>
export const workspaceMoveRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('lock'), id, taskId: id, projectId: id }),
  z.object({ op: z.literal('unlock'), id, taskId: id, projectId: id }),
  z.object({
    op: z.literal('inspect'),
    taskId: id,
    projectId: id,
    commands: z.array(z.string().min(1).max(500)).max(100).optional(),
    repoName: z.string().max(500).nullable().optional()
  }),
  z.object({ op: z.literal('snapshot'), id, taskId: id, projectId: id }),
  z.object({
    op: z.literal('begin'),
    id,
    taskId: id,
    projectId: id,
    manifest: workspaceManifestSchema
  }),
  z.object({
    op: z.literal('read'),
    id,
    path: workspaceEntrySchema.shape.path,
    offset: z.number().int().nonnegative(),
    length: z
      .number()
      .int()
      .min(1)
      .max(256 * 1024)
  }),
  z.object({ op: z.literal('offset'), id, path: workspaceEntrySchema.shape.path }),
  z.object({
    op: z.literal('write'),
    id,
    path: workspaceEntrySchema.shape.path,
    offset: z.number().int().nonnegative(),
    data: z.string().max(350_000)
  }),
  z.object({ op: z.literal('verify'), id }),
  z.object({ op: z.literal('verifySource'), id }),
  z.object({ op: z.literal('verifyDestination'), id }),
  z.object({
    op: z.literal('activate'),
    id,
    taskId: id,
    projectId: id,
    repoName: z.string().max(500).nullable().optional()
  }),
  z.object({ op: z.literal('discard'), id }),
  /** Clone the task's repository where this computer keeps it (the project folder, or
   *  `repoName` inside it). Refused when that folder already holds anything. */
  z.object({
    op: z.literal('clone'),
    taskId: id,
    projectId: id,
    repoName: z.string().max(500).nullable().optional(),
    url: z
      .string()
      .min(1)
      .max(4000)
      .refine((u) => !u.startsWith('-') && !u.includes('\0') && !/^ext::/i.test(u))
  })
])

/** What `inspect` reports about this computer's copy of the task's project. */
export interface WorkspaceMoveInspection {
  projectReady: boolean
  repoReady: boolean
  worktreeGit: boolean
  hasWork: boolean
  sessionModes: string[]
  commands: Record<string, boolean>
  agents: Record<string, boolean>
  /** The project's folder recorded on this computer, whether or not it exists. */
  folder: string | null
  /** Where the task's repository lives here (the folder, or `repoName` inside it). */
  repoPath: string | null
  /** The repository's `origin` remote here, if any. */
  remoteUrl: string | null
}
