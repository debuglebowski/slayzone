import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { TaskArtifact } from '@slayzone/task/shared'

interface UseArtifactClipboardArgs {
  taskId: string
  artifacts: TaskArtifact[]
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  deleteArtifact: (id: string) => Promise<void>
  getFilePath: (id: string) => Promise<string | null>
  flatArtifactIds: string[]
}

/**
 * Multi-select for artifact rows + the copy/cut/paste/duplicate/delete clipboard.
 * Tracks the selected set, internal clipboard markers, and whether the OS clipboard
 * holds files. Keeps the multi-select set in sync with single-select changes.
 */
export function useArtifactClipboard({
  taskId,
  artifacts,
  selectedId,
  setSelectedId,
  deleteArtifact,
  getFilePath,
  flatArtifactIds
}: UseArtifactClipboardArgs) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const writeFilePathsMutation = useMutation(trpc.app.clipboard.writeFilePaths.mutationOptions())
  const pasteFilesMutation = useMutation(trpc.artifacts.pasteFiles.mutationOptions())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef<string | null>(null)
  const [clipboard, setClipboard] = useState<{ ids: string[]; mode: 'copy' | 'cut' } | null>(null)
  const [osHasFiles, setOsHasFiles] = useState(false)
  const refreshOsClipboard = useCallback(() => {
    queryClient
      .fetchQuery(trpc.app.clipboard.hasFiles.queryOptions())
      .then(setOsHasFiles)
      .catch(() => setOsHasFiles(false))
  }, [queryClient, trpc])

  // Keep multi-select in sync with single-select changes from outside (imperative handle, search panel)
  useEffect(() => {
    setSelectedIds((prev) => {
      if (selectedId == null) return prev
      if (prev.size === 1 && prev.has(selectedId)) return prev
      if (prev.size > 1 && prev.has(selectedId)) return prev
      return new Set([selectedId])
    })
  }, [selectedId])

  const handleArtifactClick = (e: React.MouseEvent, artifactId: string) => {
    const isMeta = e.metaKey || e.ctrlKey
    const isShift = e.shiftKey
    if (isMeta) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(artifactId)) next.delete(artifactId)
        else next.add(artifactId)
        return next
      })
      lastClickedRef.current = artifactId
      setSelectedId(artifactId)
      return
    }
    if (isShift && lastClickedRef.current) {
      const startIdx = flatArtifactIds.indexOf(lastClickedRef.current)
      const endIdx = flatArtifactIds.indexOf(artifactId)
      if (startIdx >= 0 && endIdx >= 0) {
        const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
        setSelectedIds(new Set(flatArtifactIds.slice(lo, hi + 1)))
        setSelectedId(artifactId)
        return
      }
    }
    setSelectedIds(new Set([artifactId]))
    lastClickedRef.current = artifactId
    setSelectedId(artifactId)
  }

  const getEffectiveArtifactIds = useCallback(
    (artifactId: string): string[] => {
      if (selectedIds.has(artifactId) && selectedIds.size > 1) return [...selectedIds]
      return [artifactId]
    },
    [selectedIds]
  )

  const writeArtifactsToOsClipboard = useCallback(
    async (ids: string[]) => {
      const paths = (await Promise.all(ids.map((id) => getFilePath(id)))).filter(
        (p): p is string => !!p
      )
      await writeFilePathsMutation.mutateAsync({ paths })
    },
    [getFilePath]
  )

  const handleArtifactCopy = useCallback(
    (ids: string[]) => {
      if (!ids.length) return
      setClipboard({ ids, mode: 'copy' })
      void writeArtifactsToOsClipboard(ids)
    },
    [writeArtifactsToOsClipboard]
  )

  const handleArtifactCut = useCallback(
    (ids: string[]) => {
      if (!ids.length) return
      setClipboard({ ids, mode: 'cut' })
      void writeArtifactsToOsClipboard(ids)
    },
    [writeArtifactsToOsClipboard]
  )

  const handleArtifactPaste = async (destFolderId: string | null) => {
    const osPaths = await queryClient.fetchQuery(trpc.app.clipboard.readFilePaths.queryOptions())
    if (!osPaths.length) return
    const created = await pasteFilesMutation.mutateAsync({
      sourcePaths: osPaths,
      destTaskId: taskId,
      destFolderId
    })
    // Cut-mode source delete only if internal clipboard markers still match OS clipboard
    if (clipboard?.mode === 'cut') {
      const sourcePathSet = new Set(osPaths)
      const internalPaths = (
        await Promise.all(clipboard.ids.map((id) => getFilePath(id)))
      ).filter((p): p is string => !!p)
      const matchesInternal =
        internalPaths.length === osPaths.length &&
        internalPaths.every((p) => sourcePathSet.has(p))
      if (matchesInternal) {
        for (const id of clipboard.ids) {
          await deleteArtifact(id)
        }
        setClipboard(null)
      }
    }
    if (created.length) {
      setSelectedIds(new Set(created.map((a) => a.id)))
      setSelectedId(created[created.length - 1].id)
      lastClickedRef.current = created[created.length - 1].id
    }
  }

  const handleArtifactDuplicate = useCallback(
    async (ids: string[]) => {
      if (!ids.length) return
      const paths = (await Promise.all(ids.map((id) => getFilePath(id)))).filter(
        (p): p is string => !!p
      )
      if (!paths.length) return
      const sourceArtifact = artifacts.find((a) => a.id === ids[0])
      const destFolderId = sourceArtifact?.folder_id ?? null
      await pasteFilesMutation.mutateAsync({
        sourcePaths: paths,
        destTaskId: taskId,
        destFolderId
      })
    },
    [getFilePath, artifacts, taskId]
  )

  const handleDeleteSelected = async (ids: string[]) => {
    for (const id of ids) await deleteArtifact(id)
    setSelectedIds(new Set())
  }

  const handleSelectAll = () => {
    setSelectedIds(new Set(flatArtifactIds))
  }

  return {
    selectedIds,
    setSelectedIds,
    clipboard,
    osHasFiles,
    refreshOsClipboard,
    handleArtifactClick,
    getEffectiveArtifactIds,
    handleArtifactCopy,
    handleArtifactCut,
    handleArtifactPaste,
    handleArtifactDuplicate,
    handleDeleteSelected,
    handleSelectAll
  }
}
