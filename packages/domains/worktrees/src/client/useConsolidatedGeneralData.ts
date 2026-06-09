import { useState, useEffect, useCallback, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { Task, UpdateTaskInput } from '@slayzone/task/shared'
import type {
  AheadBehind,
  StatusSummary,
  DiffStatsSummary,
  WorktreeMetadata,
  GhPullRequest
} from '../shared/types'
import {
  DEFAULT_WORKTREE_BASE_PATH_TEMPLATE,
  joinWorktreePath,
  resolveWorktreeBasePathTemplate,
  slugify
} from './utils'
import { toast, useStablePoll } from '@slayzone/ui'

export interface DetectedWorktreeItem {
  path: string
  branch: string | null
  isMain: boolean
}

export interface CopyFilesDialogState {
  open: boolean
  repoPath: string
  /** Pending worktree creation params — worktree doesn't exist yet */
  pendingWorktreePath: string
  pendingBranch: string
  pendingSourceBranch: string | null
  /** When true, pendingBranch is an existing branch to check out (not a new branch to create) */
  useExistingBranch?: boolean
}

export interface ConsolidatedGeneralData {
  // General data
  isGitRepo: boolean | null
  currentBranch: string | null
  worktreeBranch: string | null
  statusSummary: StatusSummary | null
  remoteUrl: string | null
  upstreamAB: AheadBehind | null

  // Branch/worktree data
  forkPoint: string | null
  featureCount: number
  baseCount: number
  taskBranch: string | null
  diffStats: DiffStatsSummary | null
  pr: GhPullRequest | null
  metadata: WorktreeMetadata | null
  branchLoading: boolean

  // Computed
  hasWorktree: boolean
  targetPath: string | null
  totalChanges: number
  parentBranch: string | null
  sluggedBranch: string

  // Actions
  handleAddWorktree: () => Promise<void>
  handleAddWorktreeFromBranch: (sourceBranch: string) => Promise<void>
  handleLinkWorktree: (worktreePath: string, branch: string | null) => Promise<void>
  handleRemoveWorktree: (branchToDelete?: string) => Promise<void>
  handleInitGit: () => Promise<void>
  handleAction: (action: string) => Promise<void>
  handleConfirmedAction: (action: string, label: string) => void
  handleCopyFilesConfirm: (choice: import('./CopyFilesDialog').CopyChoice) => Promise<void>
  handleCopyFilesCancel: () => void
  handleMergeToParent: (deleteWorktree: boolean) => Promise<void>
  confirmMergeToParent: () => void
  cancelMergeToParent: () => void
  fetchGitData: () => Promise<void>

  // Detected worktrees for linking
  detectedWorktrees: DetectedWorktreeItem[]

  // Copy files dialog
  copyFilesDialog: CopyFilesDialogState

  // Merge to parent dialog
  mergeToParentDialog: { open: boolean; hasMainChanges: boolean; deleteWorktree: boolean }

  // Action state
  creating: boolean
  initializing: boolean
  removing: boolean
  actionLoading: string | null
  createError: string | null
}

export function useConsolidatedGeneralData(
  task: Task,
  projectPath: string | null,
  visible: boolean,
  pollIntervalMs: number,
  onUpdateTask: (data: UpdateTaskInput) => Promise<Task>
): ConsolidatedGeneralData {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const initMutation = useMutation(trpc.worktrees.init.mutationOptions())
  const createWorktreeMutation = useMutation(trpc.worktrees.createWorktree.mutationOptions())
  const copyIgnoredFilesMutation = useMutation(trpc.worktrees.copyIgnoredFiles.mutationOptions())
  const removeWorktreeMutation = useMutation(trpc.worktrees.removeWorktree.mutationOptions())
  const rebaseOntoMutation = useMutation(trpc.worktrees.rebaseOnto.mutationOptions())
  const mergeFromMutation = useMutation(trpc.worktrees.mergeFrom.mutationOptions())
  const mergeIntoParentMutation = useMutation(trpc.worktrees.mergeIntoParent.mutationOptions())
  const pushMutation = useMutation(trpc.worktrees.push.mutationOptions())
  const pullMutation = useMutation(trpc.worktrees.pull.mutationOptions())
  const hasWorktree = !!task.worktree_path
  const targetPath = task.worktree_path ?? task.base_dir ?? projectPath
  const parentBranch = task.worktree_parent_branch

  // General state
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [worktreeBranch, setWorktreeBranch] = useState<string | null>(null)
  const [statusSummary, setStatusSummary] = useState<StatusSummary | null>(null)
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null)
  const [upstreamAB, setUpstreamAB] = useState<AheadBehind | null>(null)
  const [initializing, setInitializing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [detectedWorktrees, setDetectedWorktrees] = useState<DetectedWorktreeItem[]>([])
  const [copyFilesDialog, setCopyFilesDialog] = useState<CopyFilesDialogState>({
    open: false,
    repoPath: '',
    pendingWorktreePath: '',
    pendingBranch: '',
    pendingSourceBranch: null
  })
  const copyFilesDialogRef = useRef(copyFilesDialog)
  useEffect(() => {
    copyFilesDialogRef.current = copyFilesDialog
  })

  // Branch state
  const [forkPoint, setForkPoint] = useState<string | null>(null)
  const [featureCount, setFeatureCount] = useState(0)
  const [baseCount, setBaseCount] = useState(0)
  const [taskBranch, setTaskBranch] = useState<string | null>(null)
  const [diffStats, setDiffStats] = useState<DiffStatsSummary | null>(null)
  const [pr, setPr] = useState<GhPullRequest | null>(null)
  const [metadata, setMetadata] = useState<WorktreeMetadata | null>(null)
  const [branchLoading, setBranchLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const initialLoad = useRef(false)

  const lastGitHashRef = useRef<string>('')
  const lastBranchHashRef = useRef<string>('')

  // Fetch general git data — dedups setStates via hash; backoff via useStablePoll.
  const fetchGitData = useCallback(async () => {
    if (!projectPath) return null
    try {
      const isRepo = await queryClient.fetchQuery(
        trpc.worktrees.isGitRepo.queryOptions({ path: projectPath })
      )
      if (!isRepo) {
        const hash = JSON.stringify({ isRepo: false })
        if (hash !== lastGitHashRef.current) {
          lastGitHashRef.current = hash
          setIsGitRepo(false)
        }
        return hash
      }

      const [branch, remote] = await Promise.all([
        queryClient.fetchQuery(trpc.worktrees.getCurrentBranch.queryOptions({ path: projectPath })),
        queryClient.fetchQuery(trpc.worktrees.getRemoteUrl.queryOptions({ path: projectPath }))
      ])

      let status: StatusSummary | null = null
      let uab: AheadBehind | null = null
      if (targetPath) {
        const activeBranch = hasWorktree ? worktreeBranch : branch
        ;[status, uab] = await Promise.all([
          queryClient.fetchQuery(
            trpc.worktrees.getStatusSummary.queryOptions({ repoPath: targetPath })
          ),
          activeBranch
            ? queryClient.fetchQuery(
                trpc.worktrees.getAheadBehindUpstream.queryOptions({
                  path: targetPath,
                  branch: activeBranch
                })
              )
            : Promise.resolve(null)
        ])
      }

      const hash = JSON.stringify({ isRepo: true, branch, remote, status, uab })
      if (hash !== lastGitHashRef.current) {
        lastGitHashRef.current = hash
        setIsGitRepo(true)
        setCurrentBranch(branch)
        setRemoteUrl(remote)
        if (targetPath) {
          setStatusSummary(status)
          setUpstreamAB(uab)
        }
      }
      return hash
    } catch {
      return null
    }
  }, [projectPath, targetPath, hasWorktree, worktreeBranch, queryClient, trpc])

  // Fetch branch comparison data
  const fetchBranchData = useCallback(async () => {
    if (!targetPath || !parentBranch) return null
    try {
      const branch = await queryClient.fetchQuery(
        trpc.worktrees.getCurrentBranch.queryOptions({ path: targetPath })
      )
      if (!branch) {
        const hash = JSON.stringify({ branch: null })
        if (hash !== lastBranchHashRef.current) {
          lastBranchHashRef.current = hash
          setTaskBranch(null)
        }
        return hash
      }

      const repoPath = projectPath || targetPath
      const result = await queryClient.fetchQuery(
        trpc.worktrees.getResolvedForkGraph.queryOptions({
          targetPath,
          repoPath,
          activeBranch: branch,
          compareBranch: parentBranch,
          activeBranchLabel: branch,
          compareBranchLabel: parentBranch
        })
      )
      const stats = result?.forkPoint
        ? await queryClient.fetchQuery(
            trpc.worktrees.getDiffStats.queryOptions({ path: targetPath, ref: parentBranch })
          )
        : null

      // Hash only the values that drive setState — exclude `result.graph`
      // which contains time-sensitive `relativeDate` strings on every commit.
      const hash = JSON.stringify({
        branch,
        forkPoint: result?.forkPoint ?? null,
        featureCount: result?.featureCount ?? 0,
        baseCount: result?.baseCount ?? 0,
        stats
      })
      if (hash !== lastBranchHashRef.current) {
        lastBranchHashRef.current = hash
        setTaskBranch(branch)
        setForkPoint(result?.forkPoint ?? null)
        setFeatureCount(result?.featureCount ?? 0)
        setBaseCount(result?.baseCount ?? 0)
        setDiffStats(stats)
      }
      if (!initialLoad.current) {
        setBranchLoading(false)
        initialLoad.current = true
      }
      return hash
    } catch {
      if (!initialLoad.current) {
        setBranchLoading(false)
        initialLoad.current = true
      }
      return null
    }
  }, [targetPath, projectPath, parentBranch, queryClient, trpc])

  // Worktree branch
  useEffect(() => {
    if (!task.worktree_path) {
      setWorktreeBranch(null)
      return
    }
    queryClient
      .fetchQuery(trpc.worktrees.getCurrentBranch.queryOptions({ path: task.worktree_path }))
      .then(setWorktreeBranch)
      .catch(() => setWorktreeBranch(null))
  }, [task.worktree_path, queryClient, trpc])

  useStablePoll(fetchGitData, { enabled: visible && !!projectPath, baseDelayMs: pollIntervalMs })
  useStablePoll(fetchBranchData, {
    enabled: visible && !!targetPath && !!parentBranch,
    baseDelayMs: pollIntervalMs
  })

  // External handle: drops the polling return value to fit the documented
  // `() => Promise<void>` contract.
  const fetchGitDataExternal = useCallback(async (): Promise<void> => {
    await fetchGitData()
  }, [fetchGitData])

  // PR — reactive fetch when pr_url or branch changes
  const activeBranch = hasWorktree ? worktreeBranch : currentBranch
  useEffect(() => {
    const repoPath = projectPath || targetPath
    if (!repoPath) return
    if (task.pr_url) {
      queryClient
        .fetchQuery(trpc.worktrees.getPrByUrl.queryOptions({ repoPath, url: task.pr_url }))
        .then(setPr)
        .catch(() => setPr(null))
    } else if (activeBranch) {
      queryClient
        .fetchQuery(trpc.worktrees.listOpenPrs.queryOptions({ repoPath }))
        .then((prs) => setPr(prs.find((p) => p.headRefName === activeBranch) ?? null))
        .catch(() => setPr(null))
    }
  }, [task.pr_url, activeBranch, projectPath, targetPath, queryClient, trpc])

  // Metadata — one-time per worktree path
  useEffect(() => {
    if (!task.worktree_path) return
    queryClient
      .fetchQuery(trpc.worktrees.getWorktreeMetadata.queryOptions({ path: task.worktree_path }))
      .then(setMetadata)
      .catch(() => setMetadata(null))
  }, [task.worktree_path, queryClient, trpc])

  // Reset on path change
  useEffect(() => {
    initialLoad.current = false
  }, [targetPath])

  // Actions
  const handleInitGit = useCallback(async () => {
    if (!projectPath) return
    setInitializing(true)
    try {
      await initMutation.mutateAsync({ path: projectPath })
      setIsGitRepo(true)
      const branch = await queryClient.fetchQuery(
        trpc.worktrees.getCurrentBranch.queryOptions({ path: projectPath })
      )
      setCurrentBranch(branch)
    } catch {
      /* ignore */
    } finally {
      setInitializing(false)
    }
  }, [projectPath, queryClient, trpc])

  /** Resolve worktree path params (shared by direct create and ask-dialog flows) */
  const resolveWorktreeParams = useCallback(async () => {
    if (!projectPath) return null
    const basePathTemplate =
      (await queryClient.fetchQuery(
        trpc.settings.get.queryOptions({ key: 'worktree_base_path' })
      )) || DEFAULT_WORKTREE_BASE_PATH_TEMPLATE
    const basePath = resolveWorktreeBasePathTemplate(basePathTemplate, projectPath)
    const branch = slugify(task.title) || `task-${task.id.slice(0, 8)}`
    const worktreePath = joinWorktreePath(basePath, branch)
    return { branch, worktreePath }
  }, [projectPath, task.title, task.id, queryClient, trpc])

  /** Create worktree (no auto-copy), optionally copy specific files, then link to task */
  const createWorktreeAndLink = useCallback(
    async (
      worktreePath: string,
      branch: string,
      filesToCopy?: string[] | 'all',
      useExistingBranch?: boolean
    ) => {
      if (!projectPath) return
      // Omit projectId so server skips copy resolution — we handle it here
      await createWorktreeMutation.mutateAsync({
        repoPath: projectPath,
        targetPath: worktreePath,
        ...(useExistingBranch ? { sourceBranch: branch } : { branch })
      })
      if (filesToCopy === 'all') {
        await copyIgnoredFilesMutation.mutateAsync({
          repoPath: projectPath,
          worktreePath,
          paths: [],
          mode: 'all'
        })
      } else if (Array.isArray(filesToCopy) && filesToCopy.length > 0) {
        await copyIgnoredFilesMutation.mutateAsync({
          repoPath: projectPath,
          worktreePath,
          paths: filesToCopy,
          mode: 'custom'
        })
      }
      await onUpdateTask({ id: task.id, worktreePath, worktreeParentBranch: currentBranch })
    },
    [projectPath, task.id, currentBranch, onUpdateTask]
  )

  const handleAddWorktree = useCallback(async () => {
    if (!projectPath) return
    setCreateError(null)
    try {
      const params = await resolveWorktreeParams()
      if (!params) return

      // Check copy behavior before creating
      const { behavior } = await queryClient.fetchQuery(
        trpc.worktrees.resolveCopyBehavior.queryOptions({ projectId: task.project_id })
      )
      if (behavior === 'ask') {
        // Show dialog — worktree created on confirm
        setCopyFilesDialog({
          open: true,
          repoPath: projectPath,
          pendingWorktreePath: params.worktreePath,
          pendingBranch: params.branch,
          pendingSourceBranch: currentBranch
        })
        return
      }

      // Non-ask: create immediately (server handles copy for all/custom/none)
      setCreating(true)
      await createWorktreeMutation.mutateAsync({
        repoPath: projectPath,
        targetPath: params.worktreePath,
        branch: params.branch,
        projectId: task.project_id
      })
      await onUpdateTask({
        id: task.id,
        worktreePath: params.worktreePath,
        worktreeParentBranch: currentBranch
      })
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }, [
    projectPath,
    task.id,
    task.project_id,
    currentBranch,
    onUpdateTask,
    resolveWorktreeParams,
    queryClient,
    trpc,
    createWorktreeMutation
  ])

  const handleAddWorktreeFromBranch = useCallback(
    async (sourceBranch: string) => {
      if (!projectPath) return
      setCreateError(null)
      try {
        const basePathTemplate =
          (await queryClient.fetchQuery(
            trpc.settings.get.queryOptions({ key: 'worktree_base_path' })
          )) || DEFAULT_WORKTREE_BASE_PATH_TEMPLATE
        const basePath = resolveWorktreeBasePathTemplate(basePathTemplate, projectPath)
        // Use the branch name as the directory name
        const dirName = sourceBranch.replace(/\//g, '-')
        const worktreePath = joinWorktreePath(basePath, dirName)

        const { behavior } = await queryClient.fetchQuery(
          trpc.worktrees.resolveCopyBehavior.queryOptions({ projectId: task.project_id })
        )
        if (behavior === 'ask') {
          setCopyFilesDialog({
            open: true,
            repoPath: projectPath,
            pendingWorktreePath: worktreePath,
            pendingBranch: sourceBranch,
            pendingSourceBranch: currentBranch,
            useExistingBranch: true
          })
          return
        }

        setCreating(true)
        await createWorktreeMutation.mutateAsync({
          repoPath: projectPath,
          targetPath: worktreePath,
          sourceBranch,
          projectId: task.project_id
        })
        await onUpdateTask({ id: task.id, worktreePath, worktreeParentBranch: currentBranch })
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : String(err))
      } finally {
        setCreating(false)
      }
    },
    [
      projectPath,
      task.id,
      task.project_id,
      currentBranch,
      onUpdateTask,
      queryClient,
      trpc,
      createWorktreeMutation
    ]
  )

  const handleCopyFilesConfirm = useCallback(
    async (choice: import('./CopyFilesDialog').CopyChoice) => {
      const pending = copyFilesDialogRef.current
      setCopyFilesDialog((prev) => ({ ...prev, open: false }))

      // Create the worktree now + copy files based on mode
      setCreating(true)
      setCreateError(null)
      try {
        if (choice.mode === 'custom') {
          await createWorktreeAndLink(
            pending.pendingWorktreePath,
            pending.pendingBranch,
            choice.paths,
            pending.useExistingBranch
          )
        } else {
          await createWorktreeAndLink(
            pending.pendingWorktreePath,
            pending.pendingBranch,
            undefined,
            pending.useExistingBranch
          )
        }
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : String(err))
      } finally {
        setCreating(false)
      }
    },
    [createWorktreeAndLink]
  )

  const handleCopyFilesCancel = useCallback(() => {
    setCopyFilesDialog((prev) => ({ ...prev, open: false }))
  }, [])

  const handleLinkWorktree = useCallback(
    async (worktreePath: string, _branch: string | null) => {
      try {
        const parentBranchVal = currentBranch
        await onUpdateTask({ id: task.id, worktreePath, worktreeParentBranch: parentBranchVal })
      } catch (err) {
        setCreateError(err instanceof Error ? err.message : String(err))
      }
    },
    [task.id, currentBranch, onUpdateTask]
  )

  const handleRemoveWorktree = useCallback(
    async (branchToDelete?: string) => {
      if (!projectPath || !task.worktree_path) return
      setRemoving(true)
      try {
        const result = await removeWorktreeMutation.mutateAsync({
          repoPath: projectPath,
          worktreePath: task.worktree_path,
          branchHint: branchToDelete
        })
        await onUpdateTask({ id: task.id, worktreePath: null, worktreeParentBranch: null })
        if (result.branchError) {
          toast(result.branchError)
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to remove worktree')
      } finally {
        setRemoving(false)
      }
    },
    [projectPath, task.id, task.worktree_path, onUpdateTask]
  )

  // Fetch detected worktrees when no worktree is linked
  useEffect(() => {
    if (hasWorktree || !projectPath) {
      setDetectedWorktrees([])
      return
    }
    queryClient
      .fetchQuery(trpc.worktrees.detectWorktrees.queryOptions({ repoPath: projectPath }))
      .then((wts) => setDetectedWorktrees(wts.filter((w) => !w.isMain)))
      .catch(() => setDetectedWorktrees([]))
  }, [hasWorktree, projectPath, queryClient, trpc])

  const handleAction = useCallback(
    async (action: string) => {
      if (!targetPath || !parentBranch || !taskBranch) return
      setActionLoading(action)
      try {
        if (action === 'rebase') {
          const result = await rebaseOntoMutation.mutateAsync({
            path: targetPath,
            ontoBranch: parentBranch
          })
          if (result.success) {
            toast('Rebase complete')
            fetchBranchData()
          } else if (result.conflicted) toast(result.error ?? 'Rebase has conflicts')
          else toast(result.error ?? 'Rebase failed')
        } else if (action === 'merge') {
          const result = await mergeFromMutation.mutateAsync({
            path: targetPath,
            branch: parentBranch
          })
          if (result.success) {
            toast(`Merged ${parentBranch}`)
            fetchBranchData()
          } else if (result.conflicted) toast(result.error ?? 'Merge has conflicts')
          else toast(result.error ?? 'Merge failed')
        } else if (action === 'mergeToParent') {
          if (!projectPath) return
          const result = await mergeIntoParentMutation.mutateAsync({
            projectPath,
            parentBranch,
            sourceBranch: taskBranch
          })
          if (result.success) {
            toast(`Merged into ${parentBranch}`)
            fetchBranchData()
          } else if (result.conflicted) toast(result.error ?? 'Merge has conflicts')
          else toast(result.error ?? 'Merge failed')
        } else if (action === 'push') {
          const result = await pushMutation.mutateAsync({ path: targetPath, branch: taskBranch })
          toast(result.success ? 'Pushed' : (result.error ?? 'Push failed'))
        } else if (action === 'pull') {
          const result = await pullMutation.mutateAsync({ path: targetPath })
          if (result.success) {
            toast('Pulled')
            fetchBranchData()
          } else toast(result.error ?? 'Pull failed')
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Action failed')
      } finally {
        setActionLoading(null)
      }
    },
    [
      targetPath,
      parentBranch,
      taskBranch,
      projectPath,
      fetchBranchData,
      rebaseOntoMutation,
      mergeFromMutation,
      mergeIntoParentMutation,
      pushMutation,
      pullMutation
    ]
  )

  const handleConfirmedAction = useCallback(
    (action: string, label: string) => {
      toast(`${label}?`, {
        action: { label: 'Confirm', onClick: () => handleAction(action) }
      })
    },
    [handleAction]
  )

  // Merge to parent with main repo check
  const [mergeToParentDialog, setMergeToParentDialog] = useState<{
    open: boolean
    hasMainChanges: boolean
    deleteWorktree: boolean
  }>({ open: false, hasMainChanges: false, deleteWorktree: false })

  const handleMergeToParent = useCallback(
    async (deleteWorktree: boolean) => {
      if (!projectPath || !parentBranch || !taskBranch) return
      const hasChanges = await queryClient.fetchQuery(
        trpc.worktrees.hasUncommittedChanges.queryOptions({ path: projectPath })
      )
      setMergeToParentDialog({ open: true, hasMainChanges: hasChanges, deleteWorktree })
    },
    [projectPath, parentBranch, taskBranch, queryClient, trpc]
  )

  const confirmMergeToParent = useCallback(async () => {
    const shouldDelete = mergeToParentDialog.deleteWorktree
    setMergeToParentDialog({ open: false, hasMainChanges: false, deleteWorktree: false })
    await handleAction('mergeToParent')
    if (shouldDelete) await handleRemoveWorktree()
  }, [handleAction, handleRemoveWorktree, mergeToParentDialog.deleteWorktree])

  const cancelMergeToParent = useCallback(() => {
    setMergeToParentDialog({ open: false, hasMainChanges: false, deleteWorktree: false })
  }, [])

  const totalChanges = statusSummary
    ? statusSummary.staged + statusSummary.unstaged + statusSummary.untracked
    : 0

  return {
    isGitRepo,
    currentBranch,
    worktreeBranch,
    statusSummary,
    remoteUrl,
    upstreamAB,
    forkPoint,
    featureCount,
    baseCount,
    taskBranch,
    diffStats,
    pr,
    metadata,
    branchLoading,
    hasWorktree,
    targetPath,
    totalChanges,
    parentBranch,
    sluggedBranch: slugify(task.title) || `task-${task.id.slice(0, 8)}`,
    handleAddWorktree,
    handleAddWorktreeFromBranch,
    handleLinkWorktree,
    handleRemoveWorktree,
    handleInitGit,
    handleAction,
    handleConfirmedAction,
    handleMergeToParent,
    confirmMergeToParent,
    cancelMergeToParent,
    handleCopyFilesConfirm,
    handleCopyFilesCancel,
    fetchGitData: fetchGitDataExternal,
    detectedWorktrees,
    copyFilesDialog,
    mergeToParentDialog,
    creating,
    initializing,
    removing,
    actionLoading,
    createError
  }
}
