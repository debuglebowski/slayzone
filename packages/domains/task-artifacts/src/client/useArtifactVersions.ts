import { useCallback, useState } from 'react'
import type { ArtifactVersion, DiffResult, VersionRef } from '@slayzone/task-artifacts/shared'
import type { ViewingVersion } from './ArtifactsPanel.types'

interface UseArtifactVersionsArgs {
  listVersions: (
    artifactId: string,
    opts?: { limit?: number; offset?: number }
  ) => Promise<ArtifactVersion[]>
  readVersion: (artifactId: string, versionRef: VersionRef) => Promise<string>
  diffVersions: (artifactId: string, a: VersionRef, b?: VersionRef) => Promise<DiffResult>
  createVersion: (artifactId: string, name?: string | null) => Promise<ArtifactVersion>
}

/**
 * Version history state for the selected artifact: the versions list, the
 * versions dialog, and the version preview/diff viewer (incl. re-diffing against
 * a chosen base).
 */
export function useArtifactVersions({
  listVersions,
  readVersion,
  diffVersions,
  createVersion
}: UseArtifactVersionsArgs) {
  const [artifactVersions, setArtifactVersions] = useState<ArtifactVersion[]>([])
  const [versionsLoading, setVersionsLoading] = useState(false)
  const [versionsDialogOpen, setVersionsDialogOpen] = useState(false)
  const [viewingVersion, setViewingVersion] = useState<ViewingVersion | null>(null)

  const refreshVersions = useCallback(
    async (artifactId: string): Promise<void> => {
      setVersionsLoading(true)
      try {
        const rows = await listVersions(artifactId, { limit: 50 })
        setArtifactVersions(rows)
      } catch {
        setArtifactVersions([])
      } finally {
        setVersionsLoading(false)
      }
    },
    [listVersions]
  )

  const openVersion = useCallback(
    async (
      artifactId: string,
      version: ArtifactVersion,
      mode: 'diff' | 'content'
    ): Promise<void> => {
      try {
        const [content, diff] = await Promise.all([
          readVersion(artifactId, version.version_num),
          diffVersions(artifactId, version.version_num).catch(() => null)
        ])
        setViewingVersion({ version, content, diff, mode, diffAgainst: undefined })
      } catch (err) {
        console.error('Failed to load version', err)
      }
    },
    [readVersion, diffVersions]
  )

  const changeDiffAgainst = useCallback(
    async (artifactId: string, targetVersionNum: number | undefined): Promise<void> => {
      setViewingVersion((v) => (v ? { ...v, diffAgainst: targetVersionNum } : v))
      if (!viewingVersion) return
      try {
        const diff = await diffVersions(
          artifactId,
          viewingVersion.version.version_num,
          targetVersionNum
        )
        setViewingVersion((v) => (v ? { ...v, diff } : v))
      } catch {
        setViewingVersion((v) => (v ? { ...v, diff: null } : v))
      }
    },
    [diffVersions, viewingVersion]
  )

  const handleCreateVersion = useCallback(
    async (artifactId: string): Promise<void> => {
      try {
        await createVersion(artifactId)
        await refreshVersions(artifactId)
      } catch (err) {
        console.error('Create version failed', err)
      }
    },
    [createVersion, refreshVersions]
  )

  return {
    artifactVersions,
    versionsLoading,
    versionsDialogOpen,
    setVersionsDialogOpen,
    viewingVersion,
    setViewingVersion,
    refreshVersions,
    openVersion,
    changeDiffAgainst,
    handleCreateVersion
  }
}
