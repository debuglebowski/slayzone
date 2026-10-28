import type { FileMatch } from '@slayzone/terminal-contracts'
import { FileIcon, FolderIcon } from 'lucide-react'

export function renderFileItem(file: FileMatch): React.JSX.Element {
  const Icon = file.isDirectory ? FolderIcon : FileIcon
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="font-mono text-xs truncate">{file.path}</span>
    </div>
  )
}
