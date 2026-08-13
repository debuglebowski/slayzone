import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { ChevronRight, CornerLeftUp, Folder, FolderGit2, FolderPlus, HardDrive } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Input,
  cn,
  toast
} from '@slayzone/ui'

/**
 * Pick a directory on the machine that will run the agent.
 *
 * This replaces the native file dialog for every workspace path. A native dialog
 * browses the DESKTOP's filesystem, so on a remote hub or computer it yields a path
 * that does not exist where the work happens — which is how a task ends up
 * reporting "No repository path configured" for a path the user just chose. The
 * computer enumerates its own disk, the hub relays, and this renders it.
 *
 * Scope is the computer's `allowedRoots` path-jail. That is not a limitation this
 * picker imposes; it is the same boundary every other filesystem op on that
 * computer obeys, so showing anything else would offer paths that would then be
 * refused. When the jail is too narrow the answer is Settings → Computers, which
 * the empty state says out loud rather than rendering a blank tree.
 *
 * Which computer is resolved server-side, by the SAME resolution the pty backend
 * uses (`{computerId} | {taskId} | {projectId}` → explicit binding → project
 * default → connected default). The picker therefore cannot disagree with the
 * agent about which machine is meant.
 */

export interface WorkspaceDirPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the chosen ABSOLUTE path on the target machine. */
  onSelect: (path: string) => void
  /**
   * Which machine to browse. Resolved server-side; omit every field to get the
   * connected default computer (the create-project case, before a project exists).
   */
  target?: { computerId?: string | null; taskId?: string; projectId?: string }
  title?: string
  description?: string
  /** Where to open. Ignored when it falls outside the target's roots. */
  defaultPath?: string | null
  /** Offer "New folder". The two create-project flows pass true. */
  allowCreate?: boolean
}

export function WorkspaceDirPicker({
  open,
  onOpenChange,
  onSelect,
  target,
  title = 'Select directory',
  description,
  defaultPath,
  allowCreate = false
}: WorkspaceDirPickerProps) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const scope = useMemo(() => target ?? {}, [target])

  const rootsQuery = useQuery(trpc.workspace.listRoots.queryOptions(scope, { enabled: open }))
  /** Where the user has navigated. Null = still showing the computed default. */
  const [navigated, setNavigated] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [manual, setManual] = useState<string | null>(null)

  const roots = rootsQuery.data?.roots ?? []
  const sep = rootsQuery.data?.sep ?? '/'
  const home = rootsQuery.data?.home ?? null

  /**
   * Where to open: the caller's path if it is actually inside the target's roots,
   * else home, else the first root. A stale project path from ANOTHER machine
   * would otherwise open the picker on a directory the computer will refuse.
   *
   * Derived rather than pushed into state by an effect — the roots arrive
   * asynchronously, and setting state on their arrival is a cascading render for
   * a value that is a pure function of them.
   */
  const defaultCwd = useMemo(() => {
    if (roots.length === 0) return null
    const inRoots = (p: string): boolean => roots.some((r) => p === r || p.startsWith(r + sep))
    if (defaultPath && inRoots(defaultPath)) return defaultPath
    if (home && inRoots(home)) return home
    return roots[0]
  }, [roots, defaultPath, home, sep])

  const cwd = navigated ?? defaultCwd
  const setCwd = setNavigated

  /**
   * Reset on close, in the close handler rather than an effect.
   *
   * The next open must re-read: the roots may have been widened in Settings
   * meanwhile, and restoring a directory that no longer exists would open onto
   * an error.
   */
  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setNavigated(null)
      setCreating(false)
      setNewName('')
      setManual(null)
    }
    onOpenChange(next)
  }

  const listInput = { ...scope, path: cwd ?? '', dirsOnly: true }
  const listQuery = useQuery(
    trpc.workspace.listDir.queryOptions(listInput, { enabled: open && !!cwd })
  )
  const mkdir = useMutation(trpc.workspace.mkdir.mutationOptions())

  const createFolder = useCallback(async (): Promise<void> => {
    const name = newName.trim()
    if (!name || !cwd) return
    try {
      const res = await mkdir.mutateAsync({ ...scope, path: `${cwd}${sep}${name}` })
      setCreating(false)
      setNewName('')
      await queryClient.invalidateQueries(trpc.workspace.listDir.queryFilter())
      setCwd(res.path)
    } catch (err) {
      toast.error(`Could not create folder: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [newName, cwd, mkdir, scope, sep, queryClient, trpc])

  const entries = listQuery.data?.entries ?? []
  const parent = listQuery.data?.parent ?? null
  const computerId = rootsQuery.data?.computerId ?? null

  const confirm = (): void => {
    const chosen = (manual ?? cwd)?.trim()
    if (!chosen) return
    onSelect(chosen)
    handleOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex max-h-[70vh] max-w-xl flex-col"
        data-testid="workspace-dir-picker"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ??
              (computerId
                ? 'Folders on the machine that will run this task’s agents.'
                : 'Folders on this machine.')}
          </DialogDescription>
        </DialogHeader>

        {rootsQuery.isError ? (
          <p className="text-destructive text-xs" data-testid="workspace-dir-picker-error">
            Could not reach that machine:{' '}
            {rootsQuery.error instanceof Error ? rootsQuery.error.message : 'unknown error'}
          </p>
        ) : rootsQuery.isSuccess && roots.length === 0 ? (
          // A computer with no allowedRoots refuses every filesystem call. Saying
          // so — and where to fix it — beats an empty list that reads as "this
          // machine has no folders".
          <p className="text-muted-foreground text-xs" data-testid="workspace-dir-picker-no-roots">
            This computer has no allowed folders configured, so it will not open anything. Add one
            in Settings → Connections, on the computer’s row.
          </p>
        ) : (
          <>
            {/* The current path, editable. Typing an absolute path is the one
                thing the native dialog gave us that a browse-only list does not,
                and it is how you reach a directory faster than clicking to it. */}
            <div className="flex items-center gap-1">
              <IconButton
                size="icon-sm"
                variant="ghost"
                aria-label="Go up"
                title="Up one folder"
                disabled={!parent}
                onClick={() => parent && setCwd(parent)}
              >
                <CornerLeftUp className="size-3.5" />
              </IconButton>
              <Input
                value={manual ?? cwd ?? ''}
                className="font-mono text-xs"
                spellCheck={false}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (manual) setCwd(manual.trim())
                    setManual(null)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    setManual(null)
                  }
                }}
                data-testid="workspace-dir-picker-path"
              />
            </div>

            {/* Several roots = several disks/mount points; one is just the cwd. */}
            {roots.length > 1 && (
              <div className="flex flex-wrap gap-1">
                {roots.map((root) => (
                  <Button
                    key={root}
                    size="sm"
                    variant={cwd === root ? 'secondary' : 'ghost'}
                    className="h-6 font-mono text-xs"
                    onClick={() => setCwd(root)}
                  >
                    <HardDrive className="mr-1 size-3" />
                    {root}
                  </Button>
                ))}
              </div>
            )}

            <div
              className="border-border min-h-40 flex-1 overflow-y-auto rounded border"
              data-testid="workspace-dir-picker-list"
            >
              {listQuery.isError ? (
                <p className="text-destructive p-3 text-xs">
                  {listQuery.error instanceof Error
                    ? listQuery.error.message
                    : 'Could not read that folder'}
                </p>
              ) : listQuery.isPending ? (
                <p className="text-muted-foreground p-3 text-xs">Reading…</p>
              ) : entries.length === 0 ? (
                <p className="text-muted-foreground p-3 text-xs">No sub-folders here.</p>
              ) : (
                <ul>
                  {entries.map((entry) => (
                    <li key={entry.path}>
                      <button
                        type="button"
                        className={cn(
                          'hover:bg-accent flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs'
                        )}
                        onDoubleClick={() => setCwd(entry.path)}
                        onClick={() => setCwd(entry.path)}
                        data-testid="workspace-dir-entry"
                      >
                        {entry.isGitRepo ? (
                          <FolderGit2 className="text-muted-foreground size-3.5 shrink-0" />
                        ) : (
                          <Folder className="text-muted-foreground size-3.5 shrink-0" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        {/* Marking repos is the difference between picking a
                            project and picking the folder above it by mistake. */}
                        {entry.isGitRepo && (
                          <span className="text-muted-foreground shrink-0 text-[10px]">git</span>
                        )}
                        <ChevronRight className="text-muted-foreground size-3 shrink-0" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {allowCreate &&
              (creating ? (
                <div className="flex gap-2">
                  <Input
                    autoFocus
                    value={newName}
                    placeholder="New folder name"
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void createFolder()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setCreating(false)
                      }
                    }}
                    data-testid="workspace-dir-new-name"
                  />
                  <Button
                    variant="outline"
                    onClick={() => void createFolder()}
                    disabled={!newName.trim() || mkdir.isPending}
                  >
                    Create
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => setCreating(true)}
                  data-testid="workspace-dir-new-folder"
                >
                  <FolderPlus className="mr-1 size-3.5" />
                  New folder
                </Button>
              ))}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={confirm}
            disabled={!cwd && !manual}
            data-testid="workspace-dir-picker-select"
          >
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
