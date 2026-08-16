import { useState, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { track } from '@slayzone/telemetry/client'
import { safeClipboardWriteText } from '@slayzone/ui'
import type { DirEntry } from '../shared'
import { uniqueName, duplicateName } from '../shared'
import { useWorkspaceIsLocal, useWorkspaceTarget } from './workspace-target'

export interface ClipboardState {
  paths: string[]
  mode: 'copy' | 'cut'
}

interface UseFileTreeClipboardArgs {
  projectPath: string
  loadDir: (dirPath: string) => Promise<DirEntry[]>
  dirContents: Map<string, DirEntry[]>
  onFileRenamed?: (oldPath: string, newPath: string) => void
}

export function useFileTreeClipboard({
  projectPath,
  loadDir,
  dirContents,
  onFileRenamed
}: UseFileTreeClipboardArgs) {
  const trpc = useTRPC()
  // Which machine these filesystem calls are for. Ambient for the whole
  // panel — see ./workspace-target. Spread into every input so it also
  // keys the query cache.
  const target = useWorkspaceTarget()
  const queryClient = useQueryClient()
  const copyMutation = useMutation(trpc.fileEditor.copy.mutationOptions())
  const renameMutation = useMutation(trpc.fileEditor.rename.mutationOptions())
  const copyInMutation = useMutation(trpc.fileEditor.copyIn.mutationOptions())
  const showInFinderMutation = useMutation(trpc.fileEditor.showInFinder.mutationOptions())
  const writeFilePathsMutation = useMutation(trpc.app.clipboard.writeFilePaths.mutationOptions())
  // --- Internal clipboard for copy/cut ---
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null)
  const [osHasFiles, setOsHasFiles] = useState(false)
  const refreshOsClipboard = useCallback(() => {
    queryClient
      .fetchQuery(trpc.app.clipboard.hasFiles.queryOptions())
      .then(setOsHasFiles)
      .catch(() => setOsHasFiles(false))
  }, [queryClient, trpc])

  const writeOsClipboard = useCallback(
    (relPaths: string[]) => {
      const absolute = relPaths.map((p) => `${projectPath}/${p}`)
      void writeFilePathsMutation.mutateAsync({ paths: absolute })
    },
    [projectPath]
  )

  const handleCopy = useCallback(
    (paths: string[]) => {
      setClipboard({ paths, mode: 'copy' })
      writeOsClipboard(paths)
      track('file_copied')
    },
    [writeOsClipboard]
  )

  const handleCut = useCallback(
    (paths: string[]) => {
      setClipboard({ paths, mode: 'cut' })
      writeOsClipboard(paths)
      track('file_cut')
    },
    [writeOsClipboard]
  )

  const resolveCollisionPath = useCallback(
    (rawDest: string, parentDir: string): string => {
      const siblings = dirContents.get(parentDir) ?? []
      const names = new Set(siblings.map((s) => s.name))
      const name = rawDest.includes('/') ? rawDest.slice(rawDest.lastIndexOf('/') + 1) : rawDest
      const unique = uniqueName(name, names)
      if (unique === name) return rawDest
      return parentDir ? `${parentDir}/${unique}` : unique
    },
    [dirContents]
  )

  const handlePaste = useCallback(
    async (targetDir: string) => {
      if (!dirContents.has(targetDir)) await loadDir(targetDir)
      const dirsToReload = new Set<string>([targetDir])
      const projectPrefix = projectPath.endsWith('/') ? projectPath : projectPath + '/'

      let internalUsed = false
      if (clipboard) {
        // Verify OS clipboard still matches our internal state (cut paths weren't overwritten externally).
        const osPaths = await queryClient.fetchQuery(
          trpc.app.clipboard.readFilePaths.queryOptions()
        )
        const osRelative = osPaths
          .filter((p) => p === projectPath || p.startsWith(projectPrefix))
          .map((p) => (p === projectPath ? '' : p.slice(projectPrefix.length)))
        const internalSet = new Set(clipboard.paths)
        const stillMatches =
          osRelative.length === clipboard.paths.length &&
          osRelative.every((p) => internalSet.has(p))

        if (stillMatches) {
          internalUsed = true
          for (const srcPath of clipboard.paths) {
            const name = srcPath.includes('/')
              ? srcPath.slice(srcPath.lastIndexOf('/') + 1)
              : srcPath
            const rawDest = targetDir ? `${targetDir}/${name}` : name
            const destPath = resolveCollisionPath(rawDest, targetDir)
            try {
              if (clipboard.mode === 'copy') {
                await copyMutation.mutateAsync({
                  ...target,
                  rootPath: projectPath,
                  srcPath,
                  destPath
                })
              } else {
                await renameMutation.mutateAsync({
                  ...target,
                  rootPath: projectPath,
                  oldPath: srcPath,
                  newPath: destPath
                })
                onFileRenamed?.(srcPath, destPath)
                const srcParent = srcPath.includes('/')
                  ? srcPath.slice(0, srcPath.lastIndexOf('/'))
                  : ''
                dirsToReload.add(srcParent)
              }
            } catch (err) {
              console.error('Paste failed:', err)
            }
          }
          if (clipboard.mode === 'cut') setClipboard(null)
        }
      }

      if (!internalUsed) {
        const osPaths = await queryClient.fetchQuery(
          trpc.app.clipboard.readFilePaths.queryOptions()
        )
        for (const abs of osPaths) {
          try {
            if (abs === projectPath || abs.startsWith(projectPrefix)) {
              const srcRel = abs === projectPath ? '' : abs.slice(projectPrefix.length)
              if (!srcRel) continue
              const name = srcRel.includes('/') ? srcRel.slice(srcRel.lastIndexOf('/') + 1) : srcRel
              const rawDest = targetDir ? `${targetDir}/${name}` : name
              const destPath = resolveCollisionPath(rawDest, targetDir)
              await copyMutation.mutateAsync({
                ...target,
                rootPath: projectPath,
                srcPath: srcRel,
                destPath
              })
            } else {
              await copyInMutation.mutateAsync({
                ...target,
                rootPath: projectPath,
                absoluteSrc: abs,
                targetDir
              })
            }
          } catch (err) {
            console.error('External paste failed:', err)
          }
        }
      }

      track('file_pasted')
      for (const dir of dirsToReload) await loadDir(dir)
    },
    [
      clipboard,
      projectPath,
      loadDir,
      resolveCollisionPath,
      onFileRenamed,
      dirContents,
      copyMutation,
      renameMutation,
      copyInMutation,
      queryClient,
      trpc
    ]
  )

  const handleDuplicate = useCallback(
    async (entries: DirEntry[]) => {
      const dirsToReload = new Set<string>()
      for (const entry of entries) {
        const parentDir = entry.path.includes('/')
          ? entry.path.slice(0, entry.path.lastIndexOf('/'))
          : ''
        const siblings = dirContents.get(parentDir) ?? []
        const names = new Set(siblings.map((s) => s.name))
        const destName = duplicateName(entry.name, names)
        const destPath = parentDir ? `${parentDir}/${destName}` : destName
        try {
          await copyMutation.mutateAsync({
            ...target,
            rootPath: projectPath,
            srcPath: entry.path,
            destPath
          })
          dirsToReload.add(parentDir)
        } catch (err) {
          console.error('Duplicate failed:', err)
        }
      }
      track('file_duplicated')
      for (const dir of dirsToReload) await loadDir(dir)
    },
    [projectPath, dirContents, loadDir]
  )

  const handleCopyPath = useCallback(
    (entry: DirEntry, absolute: boolean) => {
      const text = absolute ? `${projectPath}/${entry.path}` : entry.path
      void safeClipboardWriteText(text)
      track('path_copied')
    },
    [projectPath]
  )

  // Deliberately NOT routed: `showInFinder` resolves against the DESKTOP, which
  // is the only machine with a file manager the user can see. `canRevealInFinder`
  // lets the menu hide the entry rather than offer one that would reveal an
  // unrelated directory that happens to share the path.
  const canRevealInFinder = useWorkspaceIsLocal()
  const handleRevealInFinder = useCallback(
    (entry: DirEntry) => {
      if (!canRevealInFinder) return
      void showInFinderMutation.mutateAsync({ rootPath: projectPath, targetPath: entry.path })
      track('reveal_in_finder')
    },
    [projectPath, canRevealInFinder]
  )

  return {
    clipboard,
    setClipboard,
    osHasFiles,
    refreshOsClipboard,
    handleCopy,
    handleCut,
    handlePaste,
    handleDuplicate,
    handleCopyPath,
    handleRevealInFinder,
    canRevealInFinder
  }
}
