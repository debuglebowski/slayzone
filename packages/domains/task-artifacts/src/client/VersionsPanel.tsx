import type { Dispatch, SetStateAction } from 'react'
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
  Tabs,
  TabsList,
  TabsTrigger,
  toast
} from '@slayzone/ui'
import type { TaskArtifact } from '@slayzone/task/shared'
import type { ArtifactVersion, VersionRef } from '@slayzone/task-artifacts/shared'
import { ArtifactVersionsDialog } from './ArtifactVersionsDialog'
import { ArtifactVersionDiffView } from './ArtifactVersionDiffView'
import type { ViewingVersion } from './ArtifactsPanel.types'

interface VersionsPanelProps {
  selectedArtifact: TaskArtifact | null
  versionsDialogOpen: boolean
  onVersionsDialogOpenChange: (open: boolean) => void
  artifactVersions: ArtifactVersion[]
  versionsLoading: boolean
  viewingVersion: ViewingVersion | null
  setViewingVersion: Dispatch<SetStateAction<ViewingVersion | null>>
  refreshVersions: (artifactId: string) => Promise<void>
  openVersion: (
    artifactId: string,
    version: ArtifactVersion,
    mode: 'diff' | 'content'
  ) => Promise<void>
  changeDiffAgainst: (artifactId: string, targetVersionNum: number | undefined) => Promise<void>
  handleCreateVersion: (artifactId: string) => Promise<void>
  setCurrentVersion: (artifactId: string, versionRef: VersionRef) => Promise<ArtifactVersion>
  renameVersion: (
    artifactId: string,
    versionRef: VersionRef,
    newName: string | null
  ) => Promise<ArtifactVersion>
}

/** Versions history dialog + the version preview/diff viewer dialog. */
export function VersionsPanel({
  selectedArtifact,
  versionsDialogOpen,
  onVersionsDialogOpenChange,
  artifactVersions,
  versionsLoading,
  viewingVersion,
  setViewingVersion,
  refreshVersions,
  openVersion,
  changeDiffAgainst,
  handleCreateVersion,
  setCurrentVersion,
  renameVersion
}: VersionsPanelProps) {
  return (
    <>
      <ArtifactVersionsDialog
        open={versionsDialogOpen}
        onOpenChange={onVersionsDialogOpenChange}
        versions={artifactVersions}
        currentVersionId={selectedArtifact?.current_version_id ?? null}
        loading={versionsLoading}
        onSetCurrent={async (ref) => {
          if (!selectedArtifact) return
          try {
            await setCurrentVersion(selectedArtifact.id, ref)
            await refreshVersions(selectedArtifact.id)
          } catch (err) {
            toast.error(
              `Failed to set current: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }}
        onRename={async (ref, newName) => {
          if (!selectedArtifact) return
          await renameVersion(selectedArtifact.id, ref, newName)
          await refreshVersions(selectedArtifact.id)
        }}
        onOpenPreview={(v) => {
          if (!selectedArtifact) return
          void openVersion(selectedArtifact.id, v, 'content')
        }}
        onDiff={(v) => {
          if (!selectedArtifact) return
          void openVersion(selectedArtifact.id, v, 'diff')
        }}
        onCreateVersion={async () => {
          if (!selectedArtifact) return
          await handleCreateVersion(selectedArtifact.id)
        }}
      />
      <Dialog
        open={viewingVersion !== null}
        onOpenChange={(open) => {
          if (!open) setViewingVersion(null)
        }}
      >
        <DialogContent className={viewingVersion?.mode === 'diff' ? 'max-w-5xl' : 'max-w-3xl'}>
          <DialogHeader>
            <DialogTitle>
              v{viewingVersion?.version.version_num}
              {viewingVersion?.version.name ? ` · ${viewingVersion.version.name}` : ''}
            </DialogTitle>
            <DialogDescription>
              {viewingVersion ? new Date(viewingVersion.version.created_at).toLocaleString() : ''}
              {viewingVersion
                ? ` · ${viewingVersion.version.size} bytes · ${viewingVersion.version.content_hash.slice(0, 8)}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {viewingVersion && viewingVersion.mode === 'diff' && viewingVersion.diff ? (
            <ArtifactVersionDiffView diff={viewingVersion.diff} />
          ) : (
            <pre className="font-mono text-xs whitespace-pre-wrap break-words bg-muted p-3 rounded max-h-[60vh] overflow-auto">
              {viewingVersion?.content}
            </pre>
          )}
          <DialogFooter className="sm:justify-between">
            {viewingVersion?.diff ? (
              <div className="flex items-center gap-2">
                <Tabs
                  value={viewingVersion.mode}
                  onValueChange={(val) =>
                    setViewingVersion((v) => (v ? { ...v, mode: val as 'diff' | 'content' } : v))
                  }
                >
                  <TabsList className="h-8">
                    <TabsTrigger
                      value="diff"
                      className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:border-transparent"
                    >
                      Diff
                    </TabsTrigger>
                    <TabsTrigger
                      value="content"
                      className="text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:border-transparent"
                    >
                      Full
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                {viewingVersion.mode === 'diff' && (
                  <Select
                    value={
                      viewingVersion.diffAgainst === undefined
                        ? '__current__'
                        : String(viewingVersion.diffAgainst)
                    }
                    onValueChange={(val) => {
                      if (!selectedArtifact) return
                      const num = val === '__current__' ? undefined : Number(val)
                      void changeDiffAgainst(selectedArtifact.id, num)
                    }}
                  >
                    <SelectTrigger size="sm" className="text-xs w-[160px]">
                      <SelectValue placeholder="vs…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__current__">vs current</SelectItem>
                      {artifactVersions
                        .filter((v) => v.version_num !== viewingVersion.version.version_num)
                        .map((v) => (
                          <SelectItem key={v.id} value={String(v.version_num)}>
                            vs v{v.version_num}
                            {v.name ? ` · ${v.name}` : ''}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setViewingVersion(null)}>
                Close
              </Button>
              <Button
                size="sm"
                disabled={
                  !viewingVersion ||
                  viewingVersion.version.id === (selectedArtifact?.current_version_id ?? null)
                }
                onClick={async () => {
                  if (!viewingVersion || !selectedArtifact) return
                  try {
                    await setCurrentVersion(selectedArtifact.id, viewingVersion.version.version_num)
                    await refreshVersions(selectedArtifact.id)
                    setViewingVersion(null)
                  } catch (err) {
                    toast.error(
                      `Failed to set current: ${err instanceof Error ? err.message : String(err)}`
                    )
                  }
                }}
              >
                Set as current
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
