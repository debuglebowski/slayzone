import { useState, useCallback } from 'react'
import { track } from '@slayzone/telemetry/client'
import type { DirEntry } from '../shared'
import { uniqueName, duplicateName } from '../shared'

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
  // --- Internal clipboard for copy/cut ---
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null)
  const [osHasFiles, setOsHasFiles] = useState(false)
  const refreshOsClipboard = useCallback(() => {
    window.api.clipboard
      .hasFiles()
      .then(setOsHasFiles)
      .catch(() => setOsHasFiles(false))
  }, [])

  const writeOsClipboard = useCallback(
    (relPaths: string[]) => {
      const absolute = relPaths.map((p) => `${projectPath}/${p}`)
      void window.api.clipboard.writeFilePaths(absolute)
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
        const osPaths = await window.api.clipboard.readFilePaths()
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
                await window.api.fs.copy(projectPath, srcPath, destPath)
              } else {
                await window.api.fs.rename(projectPath, srcPath, destPath)
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
        const osPaths = await window.api.clipboard.readFilePaths()
        for (const abs of osPaths) {
          try {
            if (abs === projectPath || abs.startsWith(projectPrefix)) {
              const srcRel = abs === projectPath ? '' : abs.slice(projectPrefix.length)
              if (!srcRel) continue
              const name = srcRel.includes('/')
                ? srcRel.slice(srcRel.lastIndexOf('/') + 1)
                : srcRel
              const rawDest = targetDir ? `${targetDir}/${name}` : name
              const destPath = resolveCollisionPath(rawDest, targetDir)
              await window.api.fs.copy(projectPath, srcRel, destPath)
            } else {
              await window.api.fs.copyIn(projectPath, abs, targetDir)
            }
          } catch (err) {
            console.error('External paste failed:', err)
          }
        }
      }

      track('file_pasted')
      for (const dir of dirsToReload) await loadDir(dir)
    },
    [clipboard, projectPath, loadDir, resolveCollisionPath, onFileRenamed, dirContents]
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
          await window.api.fs.copy(projectPath, entry.path, destPath)
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
      navigator.clipboard.writeText(text)
      track('path_copied')
    },
    [projectPath]
  )

  const handleRevealInFinder = useCallback(
    (entry: DirEntry) => {
      window.api.fs.showInFinder(projectPath, entry.path)
      track('reveal_in_finder')
    },
    [projectPath]
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
    handleRevealInFinder
  }
}
