import { X, PanelLeftClose, PanelLeft } from 'lucide-react'
import { cn } from '@slayzone/ui'
import type { OpenFile } from './useFileEditor'
import { FileIcon } from './FileIcon'

interface EditorTabBarProps {
  files: OpenFile[]
  activeFilePath: string | null
  onSelect: (path: string) => void
  onClose: (path: string) => void
  isDirty: (path: string) => boolean
  diskChanged?: (path: string) => boolean
  treeVisible?: boolean
  onToggleTree?: () => void
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path
}

export function EditorTabBar({ files, activeFilePath, onSelect, onClose, isDirty, diskChanged, treeVisible, onToggleTree }: EditorTabBarProps) {
  return (
    <div className="flex items-center h-10 px-2 gap-1 flex-1 min-w-0">
      {onToggleTree && (
        <button
          className="flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
          onClick={onToggleTree}
          title={treeVisible ? 'Hide file tree' : 'Show file tree'}
        >
          {treeVisible ? <PanelLeftClose className="size-4" /> : <PanelLeft className="size-4" />}
        </button>
      )}
      <div className="flex items-center gap-1 overflow-x-auto flex-1 min-w-0">
      {files.map((file) => {
        const active = file.path === activeFilePath
        const dirty = isDirty(file.path)
        const name = fileName(file.path)
        return (
          <button
            key={file.path}
            className={cn(
              'group flex items-center gap-1.5 px-3 h-7 text-xs rounded-md shrink-0 transition-colors',
              'bg-neutral-100 dark:bg-neutral-800/50 hover:bg-neutral-200/80 dark:hover:bg-neutral-700/50',
              active
                ? 'bg-neutral-200 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-foreground'
                : 'text-neutral-500 dark:text-neutral-400'
            )}
            onClick={() => onSelect(file.path)}
            onAuxClick={(e) => {
              if (e.button === 1) onClose(file.path)
            }}
            title={file.path}
          >
            <FileIcon fileName={name} className="size-4 shrink-0 flex items-center [&>svg]:size-full" />
            <span className="truncate max-w-[160px] font-mono">
              {name}
            </span>
            {diskChanged?.(file.path) && (
              <span className="text-[10px] leading-none text-amber-500 shrink-0">changed</span>
            )}
            <button
              type="button"
              aria-label={`Close ${name}`}
              className="grid place-items-center size-4 shrink-0 rounded hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation()
                onClose(file.path)
              }}
            >
              {dirty && (
                <span className="col-start-1 row-start-1 size-2 rounded-full bg-foreground opacity-40 transition-opacity group-hover:opacity-0" />
              )}
              <X className="col-start-1 row-start-1 size-3 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          </button>
        )
      })}
      </div>
    </div>
  )
}
