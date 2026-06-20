import {
  CommandEmpty,
  CommandGroup,
  CommandItem,
  cn,
  PriorityIcon,
  getTaskStatusStyle
} from '@slayzone/ui'
import { CheckSquare, Folder } from 'lucide-react'
import { FileIcon } from '@slayzone/icons'
import { priorityOptions } from '@slayzone/task/shared'
import type { ActionId, SearchItem, TaskTab } from './SearchDialog.types'
import type { GroupedResults } from './SearchDialog.algorithm'
import { ACTION_DEFS, ACTION_ICONS } from './SearchDialog.constants'
import { formatRelative, offsetPositions } from './SearchDialog.utils'
import { ActionShortcut } from './ActionShortcut'
import { Highlight } from './Highlight'

interface RecentItem {
  tab: TaskTab
  projectName: string
  updatedAt: string
}

interface SearchResultsProps {
  isSearching: boolean
  groups: GroupedResults
  recentItems: RecentItem[]
  onRunAction: (id: ActionId) => void
  onSelectFile: (filePath: string) => void
  onSelectTask: (taskId: string) => void
  onSelectProject: (projectId: string) => void
}

export function SearchResults({
  isSearching,
  groups,
  recentItems,
  onRunAction,
  onSelectFile,
  onSelectTask,
  onSelectProject
}: SearchResultsProps) {
  return (
    <>
      {!isSearching && (
        <>
          <CommandGroup heading="Actions">
            {ACTION_DEFS.filter((a) => a.featured).map((a) => {
              const Icon = ACTION_ICONS[a.id]
              return (
                <CommandItem
                  key={`action:${a.id}`}
                  value={`action:${a.id}`}
                  onSelect={() => onRunAction(a.id)}
                >
                  <Icon className="text-muted-foreground" />
                  <span>{a.label}</span>
                  <ActionShortcut shortcutId={a.shortcutId} />
                </CommandItem>
              )
            })}
          </CommandGroup>
          {recentItems.length > 0 && (
            <CommandGroup heading="Recent Tasks">
              {recentItems.map(({ tab, projectName, updatedAt }) => {
                const statusStyle = tab.status ? getTaskStatusStyle(tab.status) : null
                const subtitle = projectName
                const ago = formatRelative(updatedAt)
                return (
                  <CommandItem
                    key={`recent:${tab.taskId}`}
                    value={`recent:${tab.taskId}`}
                    className="!items-start"
                    onSelect={() => onSelectTask(tab.taskId)}
                  >
                    {statusStyle ? (
                      <statusStyle.icon className={cn('size-4 mt-0.5', statusStyle.iconClass)} />
                    ) : (
                      <CheckSquare className="text-muted-foreground mt-0.5" />
                    )}
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="truncate font-medium">{tab.title}</span>
                      {subtitle && (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {subtitle}
                        </span>
                      )}
                    </div>
                    {ago && (
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground mt-0.5">
                        {ago}
                      </span>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          )}
        </>
      )}

      {isSearching && groups.actions.length === 0 && groups.files.length === 0 &&
        groups.tasks.length === 0 && groups.projects.length === 0 && (
          <CommandEmpty>No results found.</CommandEmpty>
        )}

      {isSearching && groups.actions.length > 0 && (
        <CommandGroup heading="Actions">
          {groups.actions.map((r) => {
            const item = r.item as Extract<SearchItem, { kind: 'action' }>
            const Icon = ACTION_ICONS[item.id]
            return (
              <CommandItem
                key={`action:${item.id}`}
                value={`action:${item.id}`}
                onSelect={() => onRunAction(item.id)}
              >
                <Icon className="text-muted-foreground" />
                <span>
                  <Highlight text={item.label} positions={r.positions} />
                </span>
                <ActionShortcut shortcutId={item.shortcutId} />
              </CommandItem>
            )
          })}
        </CommandGroup>
      )}

      {isSearching && groups.files.length > 0 && (
        <CommandGroup heading="Files">
          {groups.files.map((r) => {
            const item = r.item as Extract<SearchItem, { kind: 'file' }>
            const namePositions = r.usedPath
              ? offsetPositions(r.positions, item.filePath.length - item.label.length)
              : r.positions
            return (
              <CommandItem key={item.id} value={item.id} onSelect={() => onSelectFile(item.filePath)}>
                <FileIcon
                  fileName={item.label}
                  className="size-4 shrink-0 flex items-center [&>svg]:size-full"
                />
                <span className="truncate font-mono text-xs">
                  <Highlight text={item.label} positions={namePositions} />
                </span>
                {item.sublabel && (
                  <span className="ml-auto text-[11px] text-muted-foreground truncate max-w-[200px]">
                    {item.sublabel}
                  </span>
                )}
              </CommandItem>
            )
          })}
        </CommandGroup>
      )}

      {isSearching && groups.tasks.length > 0 && (
        <CommandGroup heading="Tasks">
          {groups.tasks.map((r) => {
            const item = r.item as Extract<SearchItem, { kind: 'task' }>
            const statusStyle = getTaskStatusStyle(item.status)
            const priorityLabel = priorityOptions.find((o) => o.value === item.priority)?.label
            return (
              <CommandItem
                key={`task:${item.id}`}
                value={`task:${item.id}`}
                onSelect={() => onSelectTask(item.id)}
              >
                <CheckSquare className="mr-2" />
                <span className="truncate">
                  <Highlight text={item.label} positions={r.positions} />
                </span>
                <div className="ml-auto flex items-center gap-1.5 shrink-0">
                  {statusStyle && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border border-border/60 text-muted-foreground">
                      <statusStyle.icon className={cn('size-3!', statusStyle.iconClass)} />
                      {statusStyle.label}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium border border-border/60 text-muted-foreground">
                    <PriorityIcon priority={item.priority} className="size-3!" />
                    {priorityLabel}
                  </span>
                </div>
              </CommandItem>
            )
          })}
        </CommandGroup>
      )}

      {isSearching && groups.projects.length > 0 && (
        <CommandGroup heading="Projects">
          {groups.projects.map((r) => {
            const item = r.item as Extract<SearchItem, { kind: 'project' }>
            return (
              <CommandItem
                key={`project:${item.id}`}
                value={`project:${item.id}`}
                onSelect={() => onSelectProject(item.id)}
              >
                <Folder className="mr-2" />
                <span>
                  <Highlight text={item.label} positions={r.positions} />
                </span>
              </CommandItem>
            )
          })}
        </CommandGroup>
      )}
    </>
  )
}
