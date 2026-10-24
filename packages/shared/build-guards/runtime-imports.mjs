/**
 * Runtime-imports guard: every module a shipped Node bundle still resolves AT
 * RUNTIME must be resolvable where that bundle runs. Checked on the emitted
 * output, so it sees every form the source can take — and fails the build (dev
 * watch builds included) instead of shipping a `Cannot find module` that only
 * surfaces as a log line, if at all.
 *
 * A specifier left in the output is allowed only when it is:
 *   1. a Node builtin (`node:*` or `builtinModules`), or `electron` in an Electron bundle;
 *   2. a package in the bundle's own `dependencies` / `optionalDependencies`
 *      (what electron-builder ships and what `npm i` installs);
 *   3. listed in `optionalExternals` — a module whose absence the caller handles
 *      by design (e.g. ws's native accelerators, probed in try/catch).
 * `@slayzone/*` is never allowed, declared or not: workspace packages ship raw TS
 * source with extensionless imports, which Node's ESM loader cannot load.
 *
 * Why on the output: Rollup does not bundle a `require()` inside ESM source. That
 * is how `require('@slayzone/platform')` in diagnostics survived into out/main and
 * failed on every retention tick. A source lint sees one spelling; the output is
 * where every spelling — and every third-party dependency's own require — lands.
 */
import { builtinModules } from 'node:module'

const BUILTINS = new Set(builtinModules)
const WORKSPACE_SCOPE = '@slayzone/'

/** `@scope/name/sub/path` → `@scope/name`, `name/sub` → `name`. */
function packageNameOf(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * Resolved through node_modules at runtime? Relative/absolute paths are the
 * bundle's own files, and URLs (`file:`, `data:`) are not package lookups.
 * `node:` is the one scheme that is — it is handled as a builtin.
 */
function isPackageSpecifier(specifier) {
  if (specifier.startsWith('node:')) return true
  return !/^(\.|\/|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(specifier)
}

function createPolicy({ packageJson, electron = false, optionalExternals = [] }) {
  const declared = new Set(
    Object.keys({ ...packageJson.dependencies, ...packageJson.optionalDependencies })
  )
  const optional = new Set(optionalExternals)
  /** Why `specifier` cannot be resolved at runtime, or null when it can. */
  return (specifier) => {
    if (specifier.startsWith('node:') || BUILTINS.has(specifier)) return null
    const name = packageNameOf(specifier)
    if (name.startsWith(WORKSPACE_SCOPE)) {
      return 'workspace package — ships TS source, must be bundled (import it statically, or inject the value)'
    }
    if (electron && name === 'electron') return null
    if (optional.has(name)) return null
    if (declared.has(name)) return null
    return `not a dependency of ${packageJson.name ?? 'this package'} — declare it, bundle it, or list it in optionalExternals`
  }
}

/** Iterative pre-order walk over an ESTree AST (bundles nest deeper than the JS stack). */
function walk(ast, visit) {
  const stack = [ast]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i])
      continue
    }
    if (node === null || typeof node !== 'object' || typeof node.type !== 'string') continue
    visit(node)
    for (const key in node) {
      const value = node[key]
      if (value !== null && typeof value === 'object') stack.push(value)
    }
  }
}

function stringValue(node) {
  if (!node) return null
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked ?? null
  }
  return null
}

/** `createRequire(...)` or `<anything>.createRequire(...)`. */
function isCreateRequireCall(node) {
  if (node?.type !== 'CallExpression') return false
  const callee = node.callee
  if (callee.type === 'Identifier') return callee.name === 'createRequire'
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'createRequire'
  )
}

/**
 * Every literal module specifier the code resolves at runtime, with its kind.
 * Require-like calls are found by binding, not by name pattern: the free
 * `require`, esbuild's `__require`, and any name bound to a `createRequire(...)`
 * result (electron-vite's ESM shim emits `const require2 = __cjs_mod__.createRequire(...)`).
 * Text that merely looks like a require inside a string (ajv's codegen) is a
 * Literal, not a call, so it never matches.
 */
function collectRuntimeImports(ast) {
  const requireNames = new Set(['require', '__require'])
  walk(ast, (node) => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      isCreateRequireCall(node.init)
    ) {
      requireNames.add(node.id.name)
    }
  })

  const refs = []
  const add = (kind, sourceNode) => {
    const specifier = stringValue(sourceNode)
    if (specifier !== null && isPackageSpecifier(specifier)) refs.push({ kind, specifier })
  }
  walk(ast, (node) => {
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        add('import', node.source)
        break
      case 'ExportNamedDeclaration':
        if (node.source) add('import', node.source)
        break
      case 'ImportExpression':
        add('dynamic-import', node.source)
        break
      case 'CallExpression': {
        const callee = node.callee
        if (callee.type === 'Identifier' && requireNames.has(callee.name)) {
          add('require', node.arguments[0])
        } else if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          requireNames.has(callee.object.name) &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'resolve'
        ) {
          add('require.resolve', node.arguments[0])
        } else if (isCreateRequireCall(callee)) {
          add('require', node.arguments[0])
        }
        break
      }
    }
  })
  return refs
}

function formatViolations(bundleName, violations) {
  const lines = violations.map((v) => `  ${v.file}: ${v.kind} '${v.specifier}' — ${v.reason}`)
  return [
    // Rollup and esbuild already prefix the plugin name.
    `${bundleName}: ${violations.length} module(s) would fail to resolve at runtime:`,
    ...lines
  ].join('\n')
}

/**
 * Rollup / Vite plugin. Runs in `generateBundle` with `enforce: 'post'` so it
 * parses each chunk's FINAL code — after electron-vite's `renderChunk` ESM shim.
 */
export function runtimeImportsRollupPlugin(opts) {
  const check = createPolicy(opts)
  return {
    name: 'slayzone:runtime-imports',
    enforce: 'post',
    generateBundle(_outputOptions, bundle) {
      const violations = []
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue
        const seen = new Set()
        for (const ref of collectRuntimeImports(this.parse(chunk.code))) {
          const reason = check(ref.specifier)
          const key = `${ref.kind}\0${ref.specifier}`
          if (reason && !seen.has(key)) {
            seen.add(key)
            violations.push({ file: chunk.fileName, ...ref, reason })
          }
        }
      }
      if (violations.length > 0) this.error(formatViolations(opts.bundleName, violations))
    }
  }
}

/**
 * esbuild plugin. esbuild bundles `require()` itself, so the only specifiers left
 * in its output are externals — read exactly from the metafile, no parsing.
 * Forces `metafile: true`.
 */
export function runtimeImportsEsbuildPlugin(opts) {
  const check = createPolicy(opts)
  return {
    name: 'slayzone:runtime-imports',
    setup(build) {
      build.initialOptions.metafile = true
      build.onEnd((result) => {
        if (!result.metafile) return
        const violations = []
        for (const [file, output] of Object.entries(result.metafile.outputs)) {
          const seen = new Set()
          for (const imp of output.imports) {
            if (!imp.external || !isPackageSpecifier(imp.path)) continue
            const reason = check(imp.path)
            const key = `${imp.kind}\0${imp.path}`
            if (reason && !seen.has(key)) {
              seen.add(key)
              violations.push({ file, kind: imp.kind, specifier: imp.path, reason })
            }
          }
        }
        if (violations.length > 0) {
          return { errors: [{ text: formatViolations(opts.bundleName, violations) }] }
        }
      })
    }
  }
}
