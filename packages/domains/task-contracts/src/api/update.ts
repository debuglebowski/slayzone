import { z } from 'zod'

// Mirrors UpdateTaskInput (packages/domains/task-contracts/src/types.ts).
// Scalars validated strictly; opaque JSON-blob shapes (providerConfig,
// panelVisibility, browserTabs, webPanelUrls, editorOpenFiles, mergeState,
// mergeContext, loopConfig) are passthrough — their structure is defined
// and validated in their own domain modules.
/**
 * A worktree path / base dir, as given: the hub's task-path delegate judges it, once
 * (`''` is unset; a path no computer takes fails the update).
 */
const taskPath = z.string().nullable().optional()

export const updateTaskInputSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(10000).nullable().optional(),
    assignee: z.string().nullable().optional(),
    status: z.string().min(1).optional(),
    priority: z.number().int().min(1).max(5).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    dueDate: z.string().nullable().optional(),
    projectId: z.string().optional(),

    // Terminal config
    agentId: z.string().optional(),
    providerConfig: z.unknown().optional(),
    terminalShell: z.string().nullable().optional(),

    // @deprecated — use providerConfig
    claudeFlags: z.string().optional(),
    codexFlags: z.string().optional(),
    cursorFlags: z.string().optional(),
    geminiFlags: z.string().optional(),
    opencodeFlags: z.string().optional(),

    // Panel visibility
    panelVisibility: z.unknown().nullable().optional(),

    // Worktree
    worktreePath: taskPath,
    worktreeParentBranch: z.string().nullable().optional(),

    // Working dir + browser
    baseDir: taskPath,
    browserUrl: z.string().nullable().optional(),
    browserTabs: z.unknown().nullable().optional(),
    webPanelUrls: z.unknown().nullable().optional(),

    // Editor
    editorOpenFiles: z.unknown().nullable().optional(),
    diffCollapsedFiles: z.array(z.string()).nullable().optional(),

    // Git / merge / loop
    gitActiveTab: z.string().nullable().optional(),
    mergeState: z.unknown().nullable().optional(),
    mergeContext: z.unknown().nullable().optional(),
    loopConfig: z.unknown().nullable().optional(),

    // Snooze + PR
    snoozedUntil: z.string().nullable().optional(),
    prUrl: z.string().nullable().optional(),

    // Temp
    isTemporary: z.boolean().optional(),

    // Blocked
    isBlocked: z.boolean().optional(),
    blockedComment: z.string().nullable().optional(),

    // Active artifact
    activeArtifactId: z.string().nullable().optional(),
    artifactsSidebar: z
      .object({
        visible: z.boolean().optional(),
        width: z.number().positive().optional()
      })
      .strict()
      .nullable()
      .optional(),

    // Multi-repo
    repoName: z.string().nullable().optional(),

    // Reparent: undefined = no change, null = detach, string = new parent
    parentId: z.string().nullable().optional()
  })
  .strict()

export type UpdateTaskInputParsed = z.infer<typeof updateTaskInputSchema>
