import { AlertTriangle } from 'lucide-react'
import { cn, useShortcutDisplay } from '@slayzone/ui'
import type { Task, GitTabId } from '@slayzone/task/shared'

export function GitPanelTabBar({
  tabOrder,
  activeTab,
  isTabVisible,
  setActiveTab,
  task
}: {
  tabOrder: GitTabId[]
  activeTab: GitTabId
  isTabVisible: (id: GitTabId) => boolean
  setActiveTab: (tab: GitTabId) => void
  task?: Task | null
}) {
  const gitGeneralShortcut = useShortcutDisplay('panel-git')
  const gitDiffShortcut = useShortcutDisplay('panel-git-diff')

  return (
    <>
      {tabOrder.map((tabId) => {
        if (!isTabVisible(tabId)) return null
        switch (tabId) {
          case 'general':
            return (
              <TabButton
                key="general"
                active={activeTab === 'general'}
                onClick={() => setActiveTab('general')}
                shortcut={gitGeneralShortcut}
              >
                General
              </TabButton>
            )
          case 'changes':
            return (
              <TabButton
                key="changes"
                active={activeTab === 'changes'}
                onClick={() => setActiveTab('changes')}
                shortcut={gitDiffShortcut}
              >
                Diff
              </TabButton>
            )
          case 'stash':
            return (
              <TabButton
                key="stash"
                active={activeTab === 'stash'}
                onClick={() => setActiveTab('stash')}
              >
                Stash
              </TabButton>
            )
          case 'worktrees':
            return (
              <TabButton
                key="worktrees"
                active={activeTab === 'worktrees'}
                onClick={() => setActiveTab('worktrees')}
              >
                Worktrees
              </TabButton>
            )
          case 'conflicts':
            return (
              <TabButton
                key="conflicts"
                active={activeTab === 'conflicts'}
                onClick={() => setActiveTab('conflicts')}
                badge
              >
                Conflicts
              </TabButton>
            )
          case 'pr':
            return (
              <TabButton key="pr" active={activeTab === 'pr'} onClick={() => setActiveTab('pr')}>
                {task ? (
                  <>
                    Pull request
                    {task.pr_url && (
                      <span className="text-muted-foreground ml-1">
                        #{task.pr_url.match(/\/pull\/(\d+)/)?.[1]}
                      </span>
                    )}
                  </>
                ) : (
                  'Pull requests'
                )}
              </TabButton>
            )
          default:
            return null
        }
      })}
    </>
  )
}

// --- Tab button ---

function TabButton({
  active,
  onClick,
  children,
  shortcut,
  badge
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  shortcut?: string | null
  badge?: boolean
}) {
  return (
    <button
      className={cn(
        'flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors',
        active
          ? 'bg-muted text-foreground border-border shadow-sm'
          : 'bg-muted/40 text-muted-foreground border-transparent hover:bg-muted/70 hover:text-foreground'
      )}
      onClick={onClick}
    >
      {children}
      {shortcut && (
        <span
          className={cn(
            'text-[10px] leading-none',
            active ? 'text-foreground/70' : 'text-muted-foreground'
          )}
        >
          {shortcut}
        </span>
      )}
      {badge && <AlertTriangle className="h-3 w-3 text-yellow-500" />}
    </button>
  )
}
