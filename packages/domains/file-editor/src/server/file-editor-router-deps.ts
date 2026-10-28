// What the `fileEditor` router needs from its host beyond the workspace registry,
// injected so this domain never imports `@slayzone/api`. Its one member reads api's
// `AppDeps` (shared with routers still in api), so api wires this seam at load and the
// member reads that registry live on every call (`api/src/domain-router-deps.ts`).

export type FileEditorRouterDeps = {
  /** Electron shell op (host-only), over the capability bridge. */
  shellShowItemInFolder: (absPath: string) => void
}

let deps: FileEditorRouterDeps | null = null

export function setFileEditorRouterDeps(next: FileEditorRouterDeps): void {
  deps = next
}

export function getFileEditorRouterDeps(): FileEditorRouterDeps {
  if (!deps)
    throw new Error(
      'fileEditor router deps not initialized — @slayzone/api wires them when it composes the router'
    )
  return deps
}
