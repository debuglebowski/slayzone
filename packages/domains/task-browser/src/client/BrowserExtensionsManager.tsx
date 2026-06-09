import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { RotateCw, Plus, Puzzle, Trash2, TriangleAlert, Download } from 'lucide-react'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  IconButton,
  Separator,
  cn
} from '@slayzone/ui'

export interface InstalledBrowserExtension {
  id: string
  name: string
  version?: string
  icon?: string
  manifestVersion?: number
}

export interface DiscoverableBrowserExtension {
  id: string
  name: string
  version: string
  path: string
  alreadyImported: boolean
  manifestVersion?: number
}

export interface BrowserExtensionSource {
  name: string
  extensions: DiscoverableBrowserExtension[]
}

export interface ExtensionsManagerViewProps {
  extensions: InstalledBrowserExtension[]
  browserExtensions: BrowserExtensionSource[]
  isLoading: boolean
  error: string | null
  onRefresh: () => void
  onClose: () => void
  onActivate: (extensionId: string) => void
  onRemove: (extensionId: string) => void
  onImport: (path: string, name: string) => void
  onLoadUnpacked: () => void
}

/**
 * Owns all extension-manager state: installed + discoverable lists, loading/error,
 * and the open/close + activate/import/load/remove handlers.
 */
export function useBrowserExtensions() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [extensionsManagerOpen, setExtensionsManagerOpen] = useState(false)
  const [extensionsError, setExtensionsError] = useState<string | null>(null)

  // Installed + discoverable lists. Both fetch only while the manager is open;
  // the prior code refreshed them imperatively on open and after each mutation.
  const installedQuery = useQuery(
    trpc.app.browser.getExtensions.queryOptions(undefined, { enabled: extensionsManagerOpen })
  ) as { data?: InstalledBrowserExtension[]; isFetching: boolean; error: unknown }
  const discoveredQuery = useQuery(
    trpc.app.browser.discoverBrowserExtensions.queryOptions(undefined, {
      enabled: extensionsManagerOpen
    })
  ) as { data?: BrowserExtensionSource[]; isFetching: boolean; error: unknown }

  const extensions = useMemo<InstalledBrowserExtension[]>(
    () => installedQuery.data ?? [],
    [installedQuery.data]
  )

  const browserExtensions = useMemo<BrowserExtensionSource[]>(() => {
    const discovered = discoveredQuery.data ?? []
    const installedIds = new Set(extensions.map((extension) => extension.id))
    return discovered.map((browser) => ({
      ...browser,
      extensions: browser.extensions.map((extension) => ({
        ...extension,
        alreadyImported: extension.alreadyImported || installedIds.has(extension.id)
      }))
    }))
  }, [discoveredQuery.data, extensions])

  const extensionsLoading = installedQuery.isFetching || discoveredQuery.isFetching

  // Surface query-level load failures the same way the old try/catch did.
  const queryError = installedQuery.error ?? discoveredQuery.error
  const loadErrorMessage =
    queryError instanceof Error
      ? queryError.message
      : queryError
        ? 'Failed to load extensions'
        : null

  const refreshExtensions = useCallback(async () => {
    setExtensionsError(null)
    await Promise.all([
      queryClient.invalidateQueries(trpc.app.browser.getExtensions.queryFilter()),
      queryClient.invalidateQueries(trpc.app.browser.discoverBrowserExtensions.queryFilter())
    ])
  }, [queryClient, trpc])

  const handleToggleExtensionsManager = useCallback(() => {
    setExtensionsManagerOpen((prev) => !prev)
  }, [])

  // activateExtension manipulates the active WebContentsView (opens the
  // extension action in the live view) but is an app.browser router proc; keep
  // it on tRPC. Fire-and-forget after the rAF, matching the prior behavior.
  const activateMutation = useMutation(trpc.app.browser.activateExtension.mutationOptions())
  const handleActivateExtension = useCallback(
    (extensionId: string) => {
      setExtensionsManagerOpen(false)
      requestAnimationFrame(() => {
        activateMutation.mutate({ extensionId })
      })
    },
    []
  )

  const importMutation = useMutation(
    trpc.app.browser.importExtension.mutationOptions({
      onSuccess: (result) => {
        if (result && typeof result === 'object' && 'id' in result) {
          void refreshExtensions()
        } else if (result && typeof result === 'object' && 'error' in result) {
          setExtensionsError((result as { error: string }).error)
        }
      }
    })
  )
  const handleImportExtension = useCallback(
    async (path: string, name: string) => {
      try {
        await importMutation.mutateAsync({ extPath: path })
      } catch (error) {
        const message = error instanceof Error ? error.message : `Failed to import ${name}`
        setExtensionsError(message)
      }
    },
    []
  )

  const loadMutation = useMutation(
    trpc.app.browser.loadExtension.mutationOptions({
      onSuccess: (result) => {
        if (result && typeof result === 'object' && 'id' in result) {
          void refreshExtensions()
        } else if (result && typeof result === 'object' && 'error' in result) {
          setExtensionsError((result as { error: string }).error)
        }
      }
    })
  )
  const handleLoadExtension = useCallback(async () => {
    try {
      await loadMutation.mutateAsync()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load unpacked extension'
      setExtensionsError(message)
    }
  }, [])

  const removeMutation = useMutation(
    trpc.app.browser.removeExtension.mutationOptions({
      onSuccess: () => {
        void refreshExtensions()
      }
    })
  )
  const handleRemoveExtension = useCallback(
    async (extensionId: string) => {
      try {
        await removeMutation.mutateAsync({ extensionId })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to remove extension'
        setExtensionsError(message)
      }
    },
    []
  )

  return {
    extensionsManagerOpen,
    setExtensionsManagerOpen,
    extensions,
    browserExtensions,
    extensionsLoading,
    extensionsError: extensionsError ?? loadErrorMessage,
    refreshExtensions,
    handleToggleExtensionsManager,
    handleActivateExtension,
    handleImportExtension,
    handleLoadExtension,
    handleRemoveExtension
  }
}

export function ExtensionsManagerView({
  extensions,
  browserExtensions,
  isLoading,
  error,
  onRefresh,
  onClose,
  onActivate,
  onRemove,
  onImport,
  onLoadUnpacked
}: ExtensionsManagerViewProps) {
  const availableSources = browserExtensions
    .map((browser) => ({
      ...browser,
      extensions: browser.extensions.filter((extension) => !extension.alreadyImported)
    }))
    .filter((browser) => browser.extensions.length > 0)
  const availableCount = availableSources.reduce(
    (total, browser) => total + browser.extensions.length,
    0
  )
  const hasManifestV3 =
    extensions.some((extension) => extension.manifestVersion === 3) ||
    availableSources.some((browser) =>
      browser.extensions.some((extension) => extension.manifestVersion === 3)
    )

  return (
    <div
      data-testid="browser-extensions-manager"
      className="flex-1 min-h-0 overflow-y-auto bg-gradient-to-b from-surface-1 via-background to-surface-1"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold tracking-tight">Extensions</h2>
            <p className="text-sm text-muted-foreground">
              Manage installed extensions and bring in more from your local browser profiles.
            </p>
          </div>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </div>

        <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
          <Card className="gap-0">
            <CardHeader className="gap-1">
              <CardTitle className="text-base">Options</CardTitle>
              <CardDescription>
                Refresh what is installed, import from detected browsers, or load an unpacked
                extension.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-2">
                <Button onClick={onRefresh} disabled={isLoading}>
                  <RotateCw className={cn('size-4', isLoading && 'animate-spin')} />
                  Refresh lists
                </Button>
                <Button variant="outline" onClick={onLoadUnpacked} disabled={isLoading}>
                  <Plus className="size-4" />
                  Load unpacked extension...
                </Button>
              </div>
              <Separator />
              <dl className="grid gap-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Installed</dt>
                  <dd className="font-medium">{extensions.length}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-muted-foreground">Available to import</dt>
                  <dd className="font-medium">{availableCount}</dd>
                </div>
              </dl>
              {hasManifestV3 && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                  Manifest V3 extensions are marked below. Their popups, background workers, and
                  permissions may not work exactly as they do in Chrome.
                </div>
              )}
              {error && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4">
            <Card className="gap-0">
              <CardHeader className="gap-1">
                <CardTitle className="text-base">Installed extensions</CardTitle>
                <CardDescription>
                  Open an extension action in the active tab or remove it from this browser session.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {extensions.length === 0 ? (
                  <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
                    No installed extensions yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {extensions.map((extension) => (
                      <div
                        key={extension.id}
                        className={cn(
                          'flex flex-col gap-3 rounded-lg border bg-background/80 px-4 py-3',
                          extension.manifestVersion === 3 && 'border-amber-500/40 bg-amber-500/5'
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-3">
                            {extension.icon ? (
                              <img
                                src={extension.icon}
                                className="size-10 shrink-0 rounded-md"
                                alt=""
                              />
                            ) : (
                              <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                                <Puzzle className="size-4" />
                              </div>
                            )}
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <div className="truncate text-sm font-medium">{extension.name}</div>
                                {extension.manifestVersion === 3 && (
                                  <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-100">
                                    MV3
                                  </span>
                                )}
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {extension.version ? `Version ${extension.version}` : extension.id}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => onActivate(extension.id)}
                            >
                              Open
                            </Button>
                            <IconButton
                              aria-label={`Remove ${extension.name}`}
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => onRemove(extension.id)}
                            >
                              <Trash2 className="size-4" />
                            </IconButton>
                          </div>
                        </div>
                        {extension.manifestVersion === 3 && (
                          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
                            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                            <span>
                              Manifest V3 extension. Popups, service workers, or permissions may not
                              behave exactly like Chrome.
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="gap-0">
              <CardHeader className="gap-1">
                <CardTitle className="text-base">Available extensions</CardTitle>
                <CardDescription>
                  Extensions detected in local browser profiles that can be imported into SlayZone.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {availableSources.length === 0 ? (
                  <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
                    No importable extensions were detected.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {availableSources.map((browser) => (
                      <div key={browser.name} className="space-y-2">
                        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                          {browser.name}
                        </div>
                        <div className="space-y-2">
                          {browser.extensions.map((extension) => (
                            <div
                              key={extension.id}
                              className={cn(
                                'flex flex-col gap-3 rounded-lg border bg-background/80 px-4 py-3',
                                extension.manifestVersion === 3 &&
                                  'border-amber-500/40 bg-amber-500/5'
                              )}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <div className="truncate text-sm font-medium">
                                      {extension.name}
                                    </div>
                                    {extension.manifestVersion === 3 && (
                                      <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-100">
                                        MV3
                                      </span>
                                    )}
                                  </div>
                                  <div className="truncate text-xs text-muted-foreground">
                                    Version {extension.version}
                                  </div>
                                </div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => onImport(extension.path, extension.name)}
                                >
                                  <Download className="size-4" />
                                  Import
                                </Button>
                              </div>
                              {extension.manifestVersion === 3 && (
                                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
                                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                                  <span>
                                    Manifest V3 extension. Expect some behavior differences after
                                    import.
                                  </span>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
