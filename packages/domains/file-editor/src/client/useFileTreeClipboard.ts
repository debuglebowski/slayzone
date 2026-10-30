import { useState, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from './trpc'
import { useTrack } from '@slayzone/telemetry/client'
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

// Pure path helpers. Kept outside the hook so the try blocks in handlePaste hold
// no conditional expressions (React Compiler can't lower those inside try).
function parentDirOf(p: string): string {
  return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
}

function baseNameOf(p: string): string {
  return p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
}

function joinDest(targetDir: string, name: string): string {
  return targetDir ? `${targetDir}/${name}` : name
}

function isInProject(abs: string, projectPath: string, projectPrefix: string): boolean {
  return abs === projectPath || abs.startsWith(projectPrefix)
}

function relativeToProject(abs: string, projectPath: string, projectPrefix: string): string {
  return abs === projectPath ? '' : abs.slice(projectPrefix.length)
}

export function useFileTreeClipboard({
  projectPath,
  loadDir,
  dirContents,
  onFileRenamed
}: UseFileTreeClipboardArgs) {
  const { track } = useTrack()
  const trpc = useTRPC()
  // Which machine these filesystem calls are for. Ambient for the whole
  // panel — see ./workspace-target. Spread into every input so it also
  // keys the query cache.
  const target = useWorkspaceTarget()
  const queryClient = useQueryClient()
  // mutateAsync is identity-stable across renders (the mutation objects are not).
  const { mutateAsync: copyPath } = useMutation(trpc.fileEditor.copy.mutationOptions())
  const { mutateAsync: renamePath } = useMutation(trpc.fileEditor.rename.mutationOptions())
  const { mutateAsync: copyIn } = useMutation(trpc.fileEditor.copyIn.mutationOptions())
  const { mutateAsync: showInFinder } = useMutation(trpc.fileEditor.showInFinder.mutationOptions())
  const { mutateAsync: writeFilePaths } = useMutation(
    trpc.app.clipboard.writeFilePaths.mutationOptions()
  )
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
      void writeFilePaths({ paths: absolute })
    },
    [projectPath, writeFilePaths]
  )

  const handleCopy = useCallback(
    (paths: string[]) => {
      setClipboard({ paths, mode: 'copy' })
      writeOsClipboard(paths)
      track('file_copied')
    },
    [writeOsClipboard, track]
  )

  const handleCut = useCallback(
    (paths: string[]) => {
      setClipboard({ paths, mode: 'cut' })
      writeOsClipboard(paths)
      track('file_cut')
    },
    [writeOsClipboard, track]
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
                await copyPath({
                  ...target,
                  rootPath: projectPath,
                  srcPath,
                  destPath
                })
              } else {
                await renamePath({
                  ...target,
                  rootPath: projectPath,
                  oldPath: srcPath,
                  newPath: destPath
                })
                if (onFileRenamed) onFileRenamed(srcPath, destPath)
                dirsToReload.add(parentDirOf(srcPath))
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
            if (isInProject(abs, projectPath, projectPrefix)) {
              const srcRel = relativeToProject(abs, projectPath, projectPrefix)
              if (!srcRel) continue
              const destPath = resolveCollisionPath(
                joinDest(targetDir, baseNameOf(srcRel)),
                targetDir
              )
              await copyPath({
                ...target,
                rootPath: projectPath,
                srcPath: srcRel,
                destPath
              })
            } else {
              await copyIn({
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
      copyPath,
      renamePath,
      copyIn,
      queryClient,
      trpc,
      target,
      track
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
          await copyPath({
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
    [projectPath, dirContents, loadDir, copyPath, target, track]
  )

  const handleCopyPath = useCallback(
    (entry: DirEntry, absolute: boolean) => {
      const text = absolute ? `${projectPath}/${entry.path}` : entry.path
      void safeClipboardWriteText(text)
      track('path_copied')
    },
    [projectPath, track]
  )

  // Deliberately NOT routed: `showInFinder` resolves against the DESKTOP, which
  // is the only machine with a file manager the user can see. `canRevealInFinder`
  // lets the menu hide the entry rather than offer one that would reveal an
  // unrelated directory that happens to share the path.
  const canRevealInFinder = useWorkspaceIsLocal()
  const handleRevealInFinder = useCallback(
    (entry: DirEntry) => {
      if (!canRevealInFinder) return
      void showInFinder({ rootPath: projectPath, targetPath: entry.path })
      track('reveal_in_finder')
    },
    [projectPath, canRevealInFinder, showInFinder, track]
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
