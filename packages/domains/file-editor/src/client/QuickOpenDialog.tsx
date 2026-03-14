import { useState, useEffect, useRef, useMemo } from 'react'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandGroup,
  Dialog,
  DialogContent
} from '@slayzone/ui'
import { FileIcon } from '@slayzone/icons'

const MAX_RENDERED = 100

interface QuickOpenDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectPath: string
  onOpenFile: (path: string) => void
  /** Invalidates cached file list when changed */
  refreshKey?: number
}

function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true
  const lower = target.toLowerCase()
  const q = query.toLowerCase()
  let qi = 0
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++
  }
  return qi === q.length
}

export function QuickOpenDialog({ open, onOpenChange, projectPath, onOpenFile, refreshKey }: QuickOpenDialogProps) {
  const [allFiles, setAllFiles] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const cacheRef = useRef<{ path: string; key: number; files: string[] } | null>(null)

  useEffect(() => {
    if (!open) return
    const key = refreshKey ?? 0
    if (cacheRef.current?.path === projectPath && cacheRef.current?.key === key) {
      setAllFiles(cacheRef.current.files)
      return
    }
    window.api.fs.listAllFiles(projectPath).then((list) => {
      cacheRef.current = { path: projectPath, key, files: list }
      setAllFiles(list)
    })
  }, [open, projectPath, refreshKey])

  // Reset search when opening
  useEffect(() => {
    if (open) setSearch('')
  }, [open])

  // Filter + cap results client-side
  const filtered = useMemo(() => {
    if (!search) return allFiles.slice(0, MAX_RENDERED)
    const matches: string[] = []
    for (const f of allFiles) {
      if (fuzzyMatch(search, f)) {
        matches.push(f)
        if (matches.length >= MAX_RENDERED) break
      }
    }
    return matches
  }, [allFiles, search])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0" showCloseButton={false}>
        <Command shouldFilter={false} className="[&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5">
          <CommandInput
            placeholder="Open file by name..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No files found.</CommandEmpty>
            <CommandGroup>
              {filtered.map((filePath) => {
                const name = filePath.split('/').pop() ?? filePath
                const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : ''
                return (
                  <CommandItem
                    key={filePath}
                    value={filePath}
                    onSelect={() => {
                      onOpenFile(filePath)
                      onOpenChange(false)
                    }}
                  >
                    <FileIcon fileName={name} className="size-4 shrink-0 flex items-center [&>svg]:size-full" />
                    <span className="truncate font-mono text-xs">{name}</span>
                    {dir && (
                      <span className="ml-auto text-[11px] text-muted-foreground truncate max-w-[200px]">{dir}</span>
                    )}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
