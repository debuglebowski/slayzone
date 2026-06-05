import type { Dispatch, SetStateAction } from 'react'
import { Plus, Search, Server, X } from 'lucide-react'
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Input,
  Label
} from '@slayzone/ui'
import type { McpTarget } from '../shared'
import type { CuratedMcpServer } from '../shared/mcp-registry'

interface McpCatalogDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  catalogSearch: string
  setCatalogSearch: (value: string) => void
  availableCurated: CuratedMcpServer[]
  onAddFromCatalog: (curated: CuratedMcpServer) => Promise<void>
}

export function McpCatalogDialog({
  open,
  onOpenChange,
  catalogSearch,
  setCatalogSearch,
  availableCurated,
  onAddFromCatalog
}: McpCatalogDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add MCP Server</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
          <Input
            placeholder="Search servers..."
            className="pl-8 h-8 text-xs"
            value={catalogSearch}
            onChange={(e) => setCatalogSearch(e.target.value)}
          />
        </div>
        <div className="max-h-[300px] overflow-y-auto space-y-1">
          {availableCurated
            .filter(
              (c) =>
                !catalogSearch ||
                c.name.toLowerCase().includes(catalogSearch.toLowerCase()) ||
                c.description?.toLowerCase().includes(catalogSearch.toLowerCase())
            )
            .map((c) => (
              <button
                key={c.id}
                onClick={async () => {
                  await onAddFromCatalog(c)
                  onOpenChange(false)
                  setCatalogSearch('')
                }}
                className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/50"
              >
                <Server className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div>
                  <div className="text-xs font-medium">{c.name}</div>
                  {c.description && (
                    <div className="text-[11px] text-muted-foreground">{c.description}</div>
                  )}
                </div>
              </button>
            ))}
          {availableCurated.filter(
            (c) => !catalogSearch || c.name.toLowerCase().includes(catalogSearch.toLowerCase())
          ).length === 0 && (
            <p className="py-4 text-center text-xs text-muted-foreground">No servers found</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

interface McpCustomServerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  customKey: string
  setCustomKey: (value: string) => void
  customCommand: string
  setCustomCommand: (value: string) => void
  customArgs: string
  setCustomArgs: (value: string) => void
  customEnvRows: Array<{ key: string; value: string }>
  setCustomEnvRows: (value: Array<{ key: string; value: string }>) => void
  customProviders: Partial<Record<McpTarget, boolean>>
  setCustomProviders: Dispatch<SetStateAction<Partial<Record<McpTarget, boolean>>>>
  addingCustom: boolean
  mcpProviders: McpTarget[]
  writableProviders: Set<McpTarget>
  onAdd: () => Promise<void>
}

export function McpCustomServerDialog({
  open,
  onOpenChange,
  customKey,
  setCustomKey,
  customCommand,
  setCustomCommand,
  customArgs,
  setCustomArgs,
  customEnvRows,
  setCustomEnvRows,
  customProviders,
  setCustomProviders,
  addingCustom,
  mcpProviders,
  writableProviders,
  onAdd
}: McpCustomServerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Custom MCP Server</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Server key</Label>
            <Input
              value={customKey}
              onChange={(event) => setCustomKey(event.target.value)}
              placeholder="my-server"
              className="h-8 text-xs"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Command</Label>
              <Input
                value={customCommand}
                onChange={(event) => setCustomCommand(event.target.value)}
                placeholder="npx"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Args</Label>
              <Input
                value={customArgs}
                onChange={(event) => setCustomArgs(event.target.value)}
                placeholder="-y @foo/bar"
                className="h-8 text-xs"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Environment variables</Label>
            {customEnvRows.map((row, index) => (
              <div key={`${index}-${row.key}`} className="grid grid-cols-[1fr_1fr_32px] gap-2">
                <Input
                  value={row.key}
                  onChange={(event) => {
                    const next = [...customEnvRows]
                    next[index] = { ...next[index], key: event.target.value }
                    setCustomEnvRows(next)
                  }}
                  placeholder="KEY"
                  className="h-8 text-xs font-mono"
                />
                <Input
                  value={row.value}
                  onChange={(event) => {
                    const next = [...customEnvRows]
                    next[index] = { ...next[index], value: event.target.value }
                    setCustomEnvRows(next)
                  }}
                  placeholder="value"
                  className="h-8 text-xs"
                />
                <IconButton
                  aria-label="Remove variable"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setCustomEnvRows(customEnvRows.filter((_, i) => i !== index))}
                >
                  <X className="size-3.5" />
                </IconButton>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setCustomEnvRows([...customEnvRows, { key: '', value: '' }])}
            >
              <Plus className="mr-1 size-3" />
              Add variable
            </Button>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Write to providers</Label>
            {mcpProviders.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No MCP-capable providers enabled for this project.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                {mcpProviders.map((provider) => {
                  const writable = writableProviders.has(provider)
                  return (
                    <label
                      key={provider}
                      className={cn(
                        'flex items-center gap-1.5 text-xs',
                        writable ? 'cursor-pointer' : 'opacity-60'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={writable ? !!customProviders[provider] : false}
                        disabled={!writable}
                        onChange={(event) =>
                          setCustomProviders((prev) => ({
                            ...prev,
                            [provider]: event.target.checked
                          }))
                        }
                      />
                      {provider}
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => void onAdd()}
            disabled={
              addingCustom ||
              !customKey.trim() ||
              !customCommand.trim() ||
              !mcpProviders.some(
                (provider) => writableProviders.has(provider) && customProviders[provider]
              )
            }
          >
            {addingCustom ? 'Adding...' : 'Add server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
