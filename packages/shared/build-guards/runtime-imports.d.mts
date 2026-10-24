export interface RuntimeImportsGuardOptions {
  /** Shown in the error, e.g. "app main". */
  bundleName: string
  /** The package.json of the app that ships this bundle — its deps are what resolves at runtime. */
  packageJson: {
    name?: string
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }
  /** Allow `electron` (Electron main/preload bundles). */
  electron?: boolean
  /** Packages whose absence the bundle handles by design. Comment each one at the call site. */
  optionalExternals?: string[]
}

/** Shape-compatible with Rollup's and Vite's Plugin; typed loosely so neither is a dependency. */
export interface RuntimeImportsRollupPlugin {
  name: string
  enforce: 'post'
  generateBundle(this: unknown, outputOptions: unknown, bundle: Record<string, unknown>): void
}

export function runtimeImportsRollupPlugin(
  opts: RuntimeImportsGuardOptions
): RuntimeImportsRollupPlugin

export interface RuntimeImportsEsbuildPlugin {
  name: string
  setup(build: unknown): void
}

export function runtimeImportsEsbuildPlugin(
  opts: RuntimeImportsGuardOptions
): RuntimeImportsEsbuildPlugin
