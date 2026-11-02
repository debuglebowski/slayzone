import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from './trpc'
import { useDepsChanged, toast } from '@slayzone/ui'
import type { TaskArtifact } from '@slayzone/task-contracts'

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
  // mutateAsync is a stable (bound) function across renders — depend on it, not the
  // per-render mutation result object.
  const { mutateAsync: writeFilePaths } = useMutation(
    trpc.app.clipboard.writeFilePaths.mutationOptions()
  )
  const { mutateAsync: pasteFiles } = useMutation(trpc.artifacts.pasteFiles.mutationOptions())
  const { mutateAsync: copyArtifacts } = useMutation(trpc.artifacts.copy.mutationOptions())
  const clipboardWrite = useRef<Promise<void>>(Promise.resolve())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const lastClickedRef = useRef<string | null>(null)
  const [clipboard, setClipboard] = useState<{
    ids: string[]
    mode: 'copy' | 'cut'
    paths?: string[]
  } | null>(null)
  const clipboardRef = useRef(clipboard)
  useLayoutEffect(() => {
    clipboardRef.current = clipboard
  }, [clipboard])
  const [osHasFiles, setOsHasFiles] = useState(false)
  const refreshOsClipboard = useCallback(() => {
    queryClient
      .fetchQuery(trpc.app.clipboard.hasFiles.queryOptions())
      .then(setOsHasFiles)
      .catch(() => setOsHasFiles(false))
  }, [queryClient, trpc])

  // Keep multi-select in sync with single-select changes from outside (imperative
  // handle, search panel). Adjusted while rendering, on a change of `selectedId` only:
  // an effect also re-ran on every tab re-show (<Activity>) and collapsed a
  // multi-select that didn't contain the current artifact.
  if (useDepsChanged([selectedId], true)) {
    setSelectedIds((prev) => {
      if (selectedId == null) return prev
      if (prev.size === 1 && prev.has(selectedId)) return prev
      if (prev.size > 1 && prev.has(selectedId)) return prev
      return new Set([selectedId])
    })
  }

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
      await writeFilePaths({ paths })
      return queryClient.fetchQuery(trpc.app.clipboard.readFilePaths.queryOptions()) as Promise<
        string[]
      >
    },
    [getFilePath, writeFilePaths, queryClient, trpc]
  )

  const handleArtifactCopy = useCallback(
    (ids: string[]) => {
      if (!ids.length) return
      setClipboard({ ids, mode: 'copy' })
      clipboardWrite.current = clipboardWrite.current
        .catch(() => {
          /* A failed previous copy must not block the next one. */
        })
        .then(async () => {
          const paths = await writeArtifactsToOsClipboard(ids)
          clipboardRef.current = { ids, mode: 'copy', paths }
          setClipboard(clipboardRef.current)
        })
        .catch((e) => {
          toast.error(String(e))
        })
    },
    [writeArtifactsToOsClipboard]
  )

  const handleArtifactCut = useCallback(
    (ids: string[]) => {
      if (!ids.length) return
      setClipboard({ ids, mode: 'cut' })
      clipboardWrite.current = clipboardWrite.current
        .catch(() => {
          /* A failed previous cut must not block the next one. */
        })
        .then(async () => {
          const paths = await writeArtifactsToOsClipboard(ids)
          clipboardRef.current = { ids, mode: 'cut', paths }
          setClipboard(clipboardRef.current)
        })
        .catch((e) => {
          toast.error(String(e))
        })
    },
    [writeArtifactsToOsClipboard]
  )

  const handleArtifactPaste = async (destFolderId: string | null) => {
    await clipboardWrite.current
    const osPaths = await queryClient.fetchQuery(trpc.app.clipboard.readFilePaths.queryOptions())
    if (!osPaths.length) return
    const currentClipboard = clipboardRef.current
    const internalMatches =
      !!currentClipboard?.paths &&
      currentClipboard.paths.length === osPaths.length &&
      currentClipboard.paths.every((p) => osPaths.includes(p))
    const created = internalMatches
      ? await copyArtifacts({
          artifactIds: currentClipboard!.ids,
          destTaskId: taskId,
          destFolderId
        })
      : await pasteFiles({
          sourcePaths: osPaths,
          destTaskId: taskId,
          destFolderId
        })
    // Cut-mode source delete only if internal clipboard markers still match OS clipboard
    if (currentClipboard?.mode === 'cut') {
      const matchesInternal = internalMatches
      if (matchesInternal) {
        for (const id of currentClipboard.ids) {
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
      const sourceArtifact = artifacts.find((a) => a.id === ids[0])
      const destFolderId = sourceArtifact?.folder_id ?? null
      await copyArtifacts({
        artifactIds: ids,
        destTaskId: taskId,
        destFolderId
      })
    },
    [artifacts, taskId, copyArtifacts]
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
