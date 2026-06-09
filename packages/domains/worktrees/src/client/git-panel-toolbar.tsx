import { type RefObject, useCallback } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import {
  AlignJustify,
  Columns2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  SkipForward,
  WrapText
} from 'lucide-react'
import {
  Button,
  IconButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn
} from '@slayzone/ui'
import { useAppearance } from '@slayzone/settings/client'
import type { GitTabId } from '@slayzone/task/shared'
import type { DetectedRepo } from '@slayzone/projects/shared'
import { RepoKindPill } from './RepoKindPill'
import type { ConflictToolbarData } from './UnifiedGitPanel.types'
import type { GitDiffPanelHandle } from './GitDiffPanel'
import type { WorktreesTabHandle } from './WorktreesTab'
import type { StashTabHandle } from './StashTab'

export function GitPanelToolbar({
  activeTab,
  detectedRepos,
  selectedRepoName,
  isRepoStale,
  onRepoChange,
  diffRef,
  worktreesRef,
  stashRef,
  stashShowAll,
  setStashShowAll,
  conflictToolbar
}: {
  activeTab: GitTabId
  detectedRepos: DetectedRepo[]
  selectedRepoName?: string | null
  isRepoStale?: boolean
  onRepoChange?: (repoName: string) => void
  diffRef: RefObject<GitDiffPanelHandle | null>
  worktreesRef: RefObject<WorktreesTabHandle | null>
  stashRef: RefObject<StashTabHandle | null>
  stashShowAll: boolean
  setStashShowAll: (value: boolean) => void
  conflictToolbar: ConflictToolbarData | null
}) {
  const trpc = useTRPC()
  const setSettingMutation = useMutation(trpc.settings.set.mutationOptions())
  const { diffContinuousFlow, diffTreeCollapsed, diffSideBySide, diffWrap } = useAppearance()
  const setBoolSetting = useCallback(
    (key: string, value: boolean) => {
      setSettingMutation.mutate({ key, value: value ? '1' : '0' })
      window.dispatchEvent(new CustomEvent('sz:settings-changed'))
    },
    [setSettingMutation]
  )

  return (
    <>
      {detectedRepos.length > 1 && onRepoChange && (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Repo</span>
          <Select
            value={selectedRepoName ?? detectedRepos[0]?.name ?? ''}
            onValueChange={onRepoChange}
          >
            <SelectTrigger
              className={cn(
                'h-7! w-auto text-xs gap-1 px-2 py-0',
                isRepoStale && 'border-amber-500/60 text-amber-500'
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" className="w-auto overflow-x-visible">
              {detectedRepos.map((repo) => (
                <SelectItem
                  key={repo.name}
                  value={repo.name}
                  className="text-xs pl-7 pr-2 [&_[data-slot=select-item-indicator]]:right-auto [&_[data-slot=select-item-indicator]]:left-2"
                >
                  <span className="flex w-full items-center gap-1.5 whitespace-nowrap">
                    <span className="whitespace-nowrap">{repo.name}</span>
                    <span className="flex-1" />
                    {repo.kind && <RepoKindPill kind={repo.kind} />}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {activeTab === 'changes' && (
        <>
          {/* Tree-collapse toggle is only meaningful in continuous-flow mode
              — in regular mode the list stays open so the right pane always
              has a selected file to render. */}
          {diffContinuousFlow && (
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  aria-label={diffTreeCollapsed ? 'Show file tree' : 'Hide file tree'}
                  variant="ghost"
                  className={cn('h-7 w-7', !diffTreeCollapsed && 'bg-primary/15 text-primary')}
                  onClick={() => setBoolSetting('diff_tree_collapsed', !diffTreeCollapsed)}
                >
                  {diffTreeCollapsed ? (
                    <PanelLeftOpen className="h-3.5 w-3.5" />
                  ) : (
                    <PanelLeftClose className="h-3.5 w-3.5" />
                  )}
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>
                {diffTreeCollapsed ? 'Show file tree' : 'Hide file tree'}
              </TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                aria-label="Continuous flow"
                variant="ghost"
                className={cn('h-7 w-7', diffContinuousFlow && 'bg-primary/15 text-primary')}
                onClick={() => setBoolSetting('diff_continuous_flow', !diffContinuousFlow)}
              >
                <AlignJustify className="h-3.5 w-3.5" />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent>
              {diffContinuousFlow ? 'Show one file at a time' : 'Show continuous flow'}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                aria-label="Side-by-side"
                variant="ghost"
                className={cn('h-7 w-7', diffSideBySide && 'bg-primary/15 text-primary')}
                onClick={() => setBoolSetting('diff_side_by_side', !diffSideBySide)}
              >
                <Columns2 className="h-3.5 w-3.5" />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent>{diffSideBySide ? 'Unified diff' : 'Side-by-side diff'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                aria-label="Wrap lines"
                variant="ghost"
                className={cn('h-7 w-7', diffWrap && 'bg-primary/15 text-primary')}
                onClick={() => setBoolSetting('diff_wrap', !diffWrap)}
              >
                <WrapText className="h-3.5 w-3.5" />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent>{diffWrap ? 'No wrap' : 'Wrap long lines'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <IconButton
                aria-label="Refresh"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => diffRef.current?.refresh()}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </IconButton>
            </TooltipTrigger>
            <TooltipContent>Refresh</TooltipContent>
          </Tooltip>
        </>
      )}
      {activeTab === 'worktrees' && (
        <IconButton
          aria-label="Add Worktree"
          variant="ghost"
          className="h-7 w-7"
          title="Add Worktree"
          onClick={() => worktreesRef.current?.openCreateDialog()}
        >
          <Plus className="h-3.5 w-3.5" />
        </IconButton>
      )}
      {activeTab === 'stash' && (
        <>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <Switch checked={stashShowAll} onCheckedChange={setStashShowAll} />
            All branches
          </label>
          <IconButton
            aria-label="Refresh"
            variant="ghost"
            className="h-7 w-7"
            title="Refresh"
            onClick={() => stashRef.current?.refresh()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </IconButton>
        </>
      )}
      {activeTab === 'conflicts' && conflictToolbar && (
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            {conflictToolbar.resolvedCount}/{conflictToolbar.totalCount}
          </span>
          {conflictToolbar.isRebase && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1 h-7 text-xs"
              onClick={conflictToolbar.onSkipCommit}
            >
              <SkipForward className="h-3 w-3" /> Skip
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={conflictToolbar.onAbort}
          >
            Abort
          </Button>
        </div>
      )}
    </>
  )
}
