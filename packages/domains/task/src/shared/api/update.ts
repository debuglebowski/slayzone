import { z } from 'zod'

// Mirrors UpdateTaskInput (packages/domains/task/src/shared/types.ts).
// Scalars validated strictly; opaque JSON-blob shapes (providerConfig,
// panelVisibility, browserTabs, webPanelUrls, editorOpenFiles, mergeState,
// mergeContext, loopConfig) are passthrough — their structure is defined
// and validated in their own domain modules.
export const updateTaskInputSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).nullable().optional(),
    assignee: z.string().nullable().optional(),
    status: z.string().min(1).optional(),
    priority: z.number().int().min(1).max(5).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    dueDate: z.string().nullable().optional(),
    projectId: z.string().optional(),

    // Terminal config
    terminalMode: z.string().optional(),
    providerConfig: z.unknown().optional(),
    terminalShell: z.string().nullable().optional(),

    // @deprecated — use providerConfig
    claudeConversationId: z.string().nullable().optional(),
    codexConversationId: z.string().nullable().optional(),
    cursorConversationId: z.string().nullable().optional(),
    geminiConversationId: z.string().nullable().optional(),
    opencodeConversationId: z.string().nullable().optional(),
    claudeFlags: z.string().optional(),
    codexFlags: z.string().optional(),
    cursorFlags: z.string().optional(),
    geminiFlags: z.string().optional(),
    opencodeFlags: z.string().optional(),

    // Panel visibility
    panelVisibility: z.unknown().nullable().optional(),

    // Worktree
    worktreePath: z.string().nullable().optional(),
    worktreeParentBranch: z.string().nullable().optional(),

    // Working dir + browser
    baseDir: z.string().nullable().optional(),
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

    // Temp + orchestrator
    isTemporary: z.boolean().optional(),
    managerMode: z.boolean().optional(),

    // Blocked
    isBlocked: z.boolean().optional(),
    blockedComment: z.string().nullable().optional(),

    // Active asset
    activeAssetId: z.string().nullable().optional(),

    // Multi-repo
    repoName: z.string().nullable().optional(),

    // Reparent: undefined = no change, null = detach, string = new parent
    parentId: z.string().nullable().optional(),
  })
  .strict()

export type UpdateTaskInputParsed = z.infer<typeof updateTaskInputSchema>
