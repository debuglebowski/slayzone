export interface BundleInputsWatcher {
  /**
   * Re-target to the inputs of the latest build (esbuild `metafile`). `null` =
   * no successful build yet: watch `fallbackDir` recursively until there is one.
   */
  update(metafile: { inputs: Record<string, unknown> } | null, absWorkingDir?: string): void
  close(): void
}

/** Rebuild trigger for esbuild-bundled sidecars: fires when any non-node_modules bundle input changes. */
export function watchBundleInputs(opts: {
  onChange: (file: string) => void
  /** The package's own src dir — watched only until the first successful build. */
  fallbackDir: string
  debounceMs?: number
}): BundleInputsWatcher
