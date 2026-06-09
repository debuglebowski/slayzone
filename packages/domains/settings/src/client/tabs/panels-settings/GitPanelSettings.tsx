import {
  DndContext,
  closestCenter,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import {
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch
} from '@slayzone/ui'
import type { GitTabId, GitTabVisibility } from '@slayzone/task/shared'
import { isGitTabEnabled, isPanelEnabled } from '@slayzone/task/shared'
import { CARD_CLASS } from './panels-settings.constants'
import { PanelLayoutControls } from './PanelLayoutControls'
import { SortableGitTabRow } from './SortableGitTabRow'
import type { PanelSettingsState } from './usePanelSettings'

export function GitPanelSettings({ state }: { state: PanelSettingsState }) {
  const {
    panelConfig,
    savePanelConfig,
    setSetting,
    togglePanel,
    sensors,
    graphCollapsed,
    setGraphCollapsed,
    graphShowBranches,
    setGraphShowBranches,
    graphBreakOnTags,
    setGraphBreakOnTags,
    graphBreakOnMerges,
    setGraphBreakOnMerges,
    gitTabOrder,
    setGitTabOrder,
    gitTabVisibility,
    setGitTabVisibility,
    diffContextLines,
    setDiffContextLines,
    diffIgnoreWhitespace,
    setDiffIgnoreWhitespace,
    diffContinuousFlow,
    setDiffContinuousFlow,
    diffTreeCollapsed,
    setDiffTreeCollapsed,
    diffSideBySide,
    setDiffSideBySide,
    diffWrap,
    setDiffWrap
  } = state
  const saveGraphConfig = (patch: Record<string, unknown>) => {
    const next = {
      collapsed: graphCollapsed,
      showBranches: graphShowBranches,
      breakOnTags: graphBreakOnTags,
      breakOnMerges: graphBreakOnMerges,
      ...patch
    }
    if ('collapsed' in patch) setGraphCollapsed(next.collapsed as boolean)
    if ('showBranches' in patch) setGraphShowBranches(next.showBranches as boolean)
    if ('breakOnTags' in patch) setGraphBreakOnTags(next.breakOnTags as boolean)
    if ('breakOnMerges' in patch) setGraphBreakOnMerges(next.breakOnMerges as boolean)
    setSetting('commit_graph_config', JSON.stringify(next))
  }
  const handleGitTabDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIdx = gitTabOrder.indexOf(active.id as GitTabId)
    const newIdx = gitTabOrder.indexOf(over.id as GitTabId)
    if (oldIdx < 0 || newIdx < 0) return
    const next = arrayMove(gitTabOrder, oldIdx, newIdx)
    setGitTabOrder(next)
    setSetting('git_tab_order', JSON.stringify(next))
    window.dispatchEvent(new Event('sz:settings-changed'))
  }
  const toggleGitTab = (id: GitTabId, enabled: boolean) => {
    const next: GitTabVisibility = { ...gitTabVisibility, [id]: enabled }
    setGitTabVisibility(next)
    setSetting('git_tab_visibility', JSON.stringify(next))
    window.dispatchEvent(new Event('sz:settings-changed'))
  }
  return (
    <>
      <div className={CARD_CLASS}>
        {/* Tabs — order + visibility */}
        <div>
          <Label className="text-base font-semibold">Tabs</Label>
          <p className="text-xs text-muted-foreground mt-1">
            Drag to reorder. Toggle to show/hide. Conflicts tab always appears when a
            merge/rebase is in progress.
          </p>
          <div className="mt-3">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleGitTabDragEnd}
            >
              <SortableContext items={gitTabOrder} strategy={verticalListSortingStrategy}>
                <div className="space-y-1.5">
                  {gitTabOrder.map((id) => (
                    <SortableGitTabRow
                      key={id}
                      id={id}
                      enabled={isGitTabEnabled(gitTabVisibility, id)}
                      onToggle={(v) => toggleGitTab(id, v)}
                      locked={id === 'conflicts'}
                      lockedHint="Shown automatically during merge conflicts"
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        </div>

        <div className="h-px bg-border" />

        {/* Diff settings */}
        <div>
          <Label className="text-base font-semibold">Diff</Label>
          <div className="mt-3 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Enabled</span>
              <Switch
                checked={isPanelEnabled(panelConfig, 'diff', 'task')}
                onCheckedChange={(c) => togglePanel('diff', 'task', c)}
              />
            </div>
            <div className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3">
              <span className="text-sm text-muted-foreground">Context lines</span>
              <Select
                value={diffContextLines}
                onValueChange={(v) => {
                  setDiffContextLines(v as any)
                  setSetting('diff_context_lines', v)
                }}
              >
                <SelectTrigger className="max-w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">0</SelectItem>
                  <SelectItem value="3">3</SelectItem>
                  <SelectItem value="5">5</SelectItem>
                  <SelectItem value="all">All</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Ignore whitespace</span>
              <Switch
                checked={diffIgnoreWhitespace}
                onCheckedChange={(c) => {
                  setDiffIgnoreWhitespace(c)
                  setSetting('diff_ignore_whitespace', c ? '1' : '0')
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Continuous flow</span>
              <Switch
                checked={diffContinuousFlow}
                onCheckedChange={(c) => {
                  setDiffContinuousFlow(c)
                  setSetting('diff_continuous_flow', c ? '1' : '0')
                  window.dispatchEvent(new Event('sz:settings-changed'))
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Hide file tree</span>
              <Switch
                checked={diffTreeCollapsed}
                onCheckedChange={(c) => {
                  setDiffTreeCollapsed(c)
                  setSetting('diff_tree_collapsed', c ? '1' : '0')
                  window.dispatchEvent(new Event('sz:settings-changed'))
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Side-by-side</span>
              <Switch
                checked={diffSideBySide}
                onCheckedChange={(c) => {
                  setDiffSideBySide(c)
                  setSetting('diff_side_by_side', c ? '1' : '0')
                  window.dispatchEvent(new Event('sz:settings-changed'))
                }}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Wrap lines</span>
              <Switch
                checked={diffWrap}
                onCheckedChange={(c) => {
                  setDiffWrap(c)
                  setSetting('diff_wrap', c ? '1' : '0')
                  window.dispatchEvent(new Event('sz:settings-changed'))
                }}
              />
            </div>
          </div>
        </div>

        <div className="h-px bg-border" />

        {/* Commit graph defaults — matches DisplayPopover layout */}
        <div>
          <Label className="text-base font-semibold">Commit graph</Label>
          <p className="text-xs text-muted-foreground mt-1">
            Default display settings. Each task and project can override these.
          </p>
          <div className="mt-3 space-y-3">
            {/* View mode toggle — same as popover */}
            <div className="grid grid-cols-2 rounded-md border border-border/50 p-0.5 gap-0.5">
              {(
                [
                  { value: false, label: 'All commits' },
                  { value: true, label: 'Collapsed' }
                ] as const
              ).map(({ value, label }) => {
                const isActive = graphCollapsed === value
                return (
                  <button
                    key={label}
                    type="button"
                    className={`flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded transition-colors ${
                      isActive
                        ? 'bg-foreground text-background'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                    }`}
                    onClick={() => saveGraphConfig({ collapsed: value })}
                  >
                    {label}
                  </button>
                )
              })}
            </div>

            <div className="h-px bg-border" />

            <div className="flex items-center justify-between">
              <span className="text-sm">Show branches</span>
              <Switch
                checked={graphShowBranches}
                onCheckedChange={(c) => saveGraphConfig({ showBranches: c })}
              />
            </div>
            {graphCollapsed && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Break on tags</span>
                  <Switch
                    checked={graphBreakOnTags}
                    onCheckedChange={(c) => saveGraphConfig({ breakOnTags: c })}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Break on merges</span>
                  <Switch
                    checked={graphBreakOnMerges}
                    onCheckedChange={(c) => saveGraphConfig({ breakOnMerges: c })}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div className={CARD_CLASS}>
        <PanelLayoutControls orderId="git" panelConfig={panelConfig} onSave={savePanelConfig} />
      </div>
    </>
  )
}
