import type React from 'react'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { useStablePoll } from '@slayzone/ui'
import type { GhPullRequest, GhPrComment, GhPrTimelineEvent, MergeStrategy } from '../shared/types'
import { parseUnifiedDiff } from './parse-diff'
import type { FileDiff } from './parse-diff'
import { groupTimelineEvents } from './pr-timeline'

const TIMELINE_PAGE_SIZE = 25

export function useLinkedPrView({
  pr,
  projectPath,
  visible,
  onRefreshPr
}: {
  pr: GhPullRequest
  projectPath: string
  visible: boolean
  onRefreshPr: () => Promise<void>
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const addPrCommentMutation = useMutation(trpc.worktrees.addPrComment.mutationOptions())
  const editPrCommentMutation = useMutation(trpc.worktrees.editPrComment.mutationOptions())
  const mergePrMutation = useMutation(trpc.worktrees.mergePr.mutationOptions())
  const [comments, setComments] = useState<GhPrTimelineEvent[]>([])
  const [loadingComments, setLoadingComments] = useState(true)
  const [commentBody, setCommentBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [ghUser, setGhUser] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  const [editSubmitting, setEditSubmitting] = useState(false)
  const [activeTab, setActiveTab] = useState<'description' | 'activity' | 'files'>('description')

  // Merge state
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>('squash')
  const [mergeDeleteBranch, setMergeDeleteBranch] = useState(true)
  const [mergeAuto, setMergeAuto] = useState(false)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)

  // Diff state
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffFiles, setDiffFiles] = useState<FileDiff[]>([])
  const [diffError, setDiffError] = useState<string | null>(null)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())

  const fetchComments = useCallback(async () => {
    try {
      const data = await queryClient.fetchQuery(
        trpc.worktrees.getPrComments.queryOptions({ repoPath: projectPath, prNumber: pr.number })
      )
      setComments(data)
    } catch {
      /* ignore */
    }
    setLoadingComments(false)
  }, [projectPath, pr.number, queryClient, trpc])

  const refreshAll = useCallback(async () => {
    await Promise.all([onRefreshPr(), fetchComments()])
  }, [onRefreshPr, fetchComments])

  const lastCommentsHashRef = useRef<string>('')

  const fetchCommentsPoll = useCallback(async () => {
    if (!projectPath) return null
    try {
      const data = await queryClient.fetchQuery(
        trpc.worktrees.getPrComments.queryOptions({ repoPath: projectPath, prNumber: pr.number })
      )
      const hash = JSON.stringify(data)
      if (hash !== lastCommentsHashRef.current) {
        lastCommentsHashRef.current = hash
        setComments(data)
      }
      return hash
    } catch {
      return null
    }
  }, [projectPath, pr.number, queryClient, trpc])

  useStablePoll(fetchCommentsPoll, { enabled: visible, baseDelayMs: 30_000 })

  // Fetch gh user for edit button
  useEffect(() => {
    if (!visible) return
    ;(async () => {
      try {
        const user = await queryClient.fetchQuery(
          trpc.worktrees.getGhUser.queryOptions({ repoPath: projectPath })
        )
        setGhUser(user)
      } catch {
        /* ignore */
      }
    })()
  }, [visible, projectPath, queryClient, trpc])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [comments.length])

  // Auto-grow textarea
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setCommentBody(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }

  const handleSubmitComment = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!commentBody.trim()) return
    setSubmitting(true)
    setCommentError(null)
    try {
      await addPrCommentMutation.mutateAsync({
        repoPath: projectPath,
        prNumber: pr.number,
        body: commentBody.trim()
      })
      setCommentBody('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      await fetchComments()
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : 'Failed to post comment')
    }
    setSubmitting(false)
  }

  const handleReply = useCallback((comment: GhPrComment) => {
    const quoted = comment.body
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')
    setCommentBody(`${quoted}\n\n@${comment.author} `)
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
      }
    }, 0)
  }, [])

  const handleStartEdit = useCallback((comment: GhPrComment) => {
    setEditingId(comment.id)
    setEditBody(comment.body)
  }, [])

  const handleSaveEdit = useCallback(async () => {
    if (!editingId || !editBody.trim()) return
    setEditSubmitting(true)
    try {
      await editPrCommentMutation.mutateAsync({
        repoPath: projectPath,
        commentId: editingId,
        body: editBody.trim()
      })
      setEditingId(null)
      setEditBody('')
      await fetchComments()
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : 'Failed to edit comment')
    }
    setEditSubmitting(false)
  }, [editingId, editBody, projectPath, fetchComments, editPrCommentMutation])

  const handleCancelEdit = useCallback(() => {
    setEditingId(null)
    setEditBody('')
  }, [])

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const collapsableComments = comments.filter(
    (c): c is GhPrComment => c.type !== 'commit' && !!c.body
  )

  const collapseAll = useCallback(() => {
    const ids = collapsableComments.map((c) => c.id)
    if (pr.body) ids.push('__pr_body__')
    setCollapsedIds(new Set(ids))
  }, [collapsableComments, pr.body])

  const expandAll = useCallback(() => {
    setCollapsedIds(new Set())
  }, [])

  const allCollapsed =
    collapsableComments.every((c) => collapsedIds.has(c.id)) &&
    (!pr.body || collapsedIds.has('__pr_body__'))

  const groupedTimeline = useMemo(() => groupTimelineEvents(comments), [comments])
  const [timelineLimit, setTimelineLimit] = useState(TIMELINE_PAGE_SIZE)
  const visibleTimeline = useMemo(() => {
    if (groupedTimeline.length <= timelineLimit) return groupedTimeline
    return groupedTimeline.slice(groupedTimeline.length - timelineLimit)
  }, [groupedTimeline, timelineLimit])
  const hasOlderEntries = groupedTimeline.length > timelineLimit

  // Merge
  const handleMerge = async () => {
    setMerging(true)
    setMergeError(null)
    try {
      await mergePrMutation.mutateAsync({
        repoPath: projectPath,
        prNumber: pr.number,
        strategy: mergeStrategy,
        deleteBranch: mergeDeleteBranch,
        auto: mergeAuto
      })
      setMergeOpen(false)
      await onRefreshPr()
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : 'Failed to merge')
    }
    setMerging(false)
  }

  // Diff - lazy load
  const loadDiff = useCallback(async () => {
    if (diffFiles.length > 0 || diffLoading) return
    setDiffLoading(true)
    setDiffError(null)
    try {
      const raw = await queryClient.fetchQuery(
        trpc.worktrees.getPrDiff.queryOptions({ repoPath: projectPath, prNumber: pr.number })
      )
      setDiffFiles(parseUnifiedDiff(raw))
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : 'Failed to load diff')
    }
    setDiffLoading(false)
  }, [diffFiles.length, diffLoading, projectPath, pr.number, queryClient, trpc])

  const toggleFileExpand = useCallback((path: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const diffStats = useMemo(() => {
    let additions = 0,
      deletions = 0
    for (const f of diffFiles) {
      additions += f.additions
      deletions += f.deletions
    }
    return { files: diffFiles.length, additions, deletions }
  }, [diffFiles])

  const [unlinkOpen, setUnlinkOpen] = useState(false)

  return {
    // comments + activity
    comments,
    loadingComments,
    commentBody,
    submitting,
    commentError,
    scrollRef,
    textareaRef,
    collapsedIds,
    ghUser,
    editingId,
    editBody,
    setEditBody,
    editSubmitting,
    activeTab,
    setActiveTab,
    // merge
    mergeOpen,
    setMergeOpen,
    mergeStrategy,
    setMergeStrategy,
    mergeDeleteBranch,
    setMergeDeleteBranch,
    mergeAuto,
    setMergeAuto,
    merging,
    mergeError,
    handleMerge,
    // diff
    diffLoading,
    diffFiles,
    diffError,
    expandedFiles,
    loadDiff,
    toggleFileExpand,
    diffStats,
    // handlers
    refreshAll,
    handleTextareaChange,
    handleSubmitComment,
    handleReply,
    handleStartEdit,
    handleSaveEdit,
    handleCancelEdit,
    toggleCollapse,
    // timeline derived
    collapsableComments,
    collapseAll,
    expandAll,
    allCollapsed,
    groupedTimeline,
    visibleTimeline,
    hasOlderEntries,
    timelineLimit,
    setTimelineLimit,
    TIMELINE_PAGE_SIZE,
    // unlink
    unlinkOpen,
    setUnlinkOpen
  }
}
