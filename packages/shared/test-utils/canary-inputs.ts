/**
 * Shared machinery of the "canary" tests: enumerate every procedure / route of a
 * surface, call it with each path-like field (or every string leaf) set to a canary
 * file, and fail when a filesystem call that reads, lists or writes content touches a
 * canary. Used by the hub-disk canary (`packages/apps/api/src/hub-disk-canary.test.ts`)
 * and the computer's direct-link canary (`packages/apps/computer/src/direct/direct-canary.test.ts`).
 */

/** fs functions that read, list or write CONTENT. stat/exists/realpath decide access
 *  and read nothing, so they are not touches. */
export const CONTENT_FNS = new Set([
  'readFile',
  'readFileSync',
  'createReadStream',
  'createWriteStream',
  'open',
  'openSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'rename',
  'renameSync',
  'unlink',
  'unlinkSync',
  'rm',
  'rmSync',
  'readdir',
  'readdirSync',
  'opendir',
  'opendirSync',
  'symlink',
  'symlinkSync',
  'link',
  'linkSync'
])

/** `mod` with every content function reporting each argument to `onArg` first. */
export function watchFsModule<T extends object>(
  mod: T,
  onArg: (fn: string, arg: unknown) => void
): T {
  const out: Record<string, unknown> = { ...(mod as Record<string, unknown>) }
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn !== 'function' || !CONTENT_FNS.has(name)) continue
    out[name] = (...args: unknown[]) => {
      for (const a of args) onArg(name, a)
      return (fn as (...a: unknown[]) => unknown).apply(mod, args)
    }
  }
  return out as T
}

/** Field names that carry a path. */
export const isPathKey = (k: string): boolean =>
  /(^path$|^paths$|Paths?$|Dir$|^cwd$|_path$|_dir$|^dir$)/.test(k) && !/Id$/.test(k)

/** An id field: kept the caller's own in every mode, so id checks let the call through. */
export const isIdKey = (k: string): boolean => /(^id$|Id$|_id$|Ids$)/.test(k)

/** Which leaves get the canary, and which option of every union is taken. */
export interface FillMode {
  /** `paths`: path-like fields only; `all`: every string leaf but ids. */
  readonly leaves: 'paths' | 'all'
  readonly union: number
}

export interface FillOptions {
  /** A value for a non-path field: the caller's own ids, so id checks pass. */
  idFor(key: string): unknown
  /** An input with no schema (unknown/any): every path key there is. */
  opaque(canary: string): unknown
  /** Every field name a path travels under, for a free-form record. */
  pathKeys: readonly string[]
}

type Def = { type: string; [k: string]: unknown }
const defOf = (s: unknown): Def | null =>
  ((s as { _zod?: { def?: Def } })?._zod?.def ?? null) as Def | null

/** Most options any union in `schema` has (each one is tried), at most 6. */
export function maxUnion(schema: unknown, depth = 0): number {
  const def = defOf(schema)
  if (!def || depth > 8) return 1
  const kids: unknown[] = []
  if (def.type === 'object') kids.push(...Object.values(def.shape as Record<string, unknown>))
  for (const k of ['innerType', 'in', 'element', 'left', 'right'] as const)
    if (def[k]) kids.push(def[k])
  if (def.type === 'tuple') kids.push(...(def.items as unknown[]))
  let n = def.type === 'union' ? (def.options as unknown[]).length : 1
  if (def.type === 'union') kids.push(...(def.options as unknown[]))
  for (const k of kids) n = Math.max(n, maxUnion(k, depth + 1))
  return Math.min(n, 6)
}

/** A value for zod `schema` with every path-like field (or string leaf) set to `canary`. */
export function fillInput(
  schema: unknown,
  canary: string,
  mode: FillMode,
  opts: FillOptions,
  key = '',
  depth = 0
): unknown {
  const def = defOf(schema)
  if (!def || depth > 8) return opts.opaque(canary)
  const next = (s: unknown, k = key) => fillInput(s, canary, mode, opts, k, depth + 1)
  switch (def.type) {
    case 'object': {
      const shape = def.shape as Record<string, unknown>
      const o: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(shape)) o[k] = next(v, k)
      return o
    }
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'nonoptional':
    case 'catch':
      return next(def.innerType)
    case 'pipe':
      return next(def.in)
    case 'lazy':
      return next((def.getter as () => unknown)())
    case 'array':
      return [next(def.element)]
    case 'tuple':
      return (def.items as unknown[]).map((i) => next(i))
    case 'union': {
      const options = def.options as unknown[]
      return next(options[mode.union % options.length])
    }
    case 'intersection':
      return { ...(next(def.left) as object), ...(next(def.right) as object) }
    case 'string':
      if (isPathKey(key)) return canary
      return mode.leaves === 'all' && !isIdKey(key) ? canary : opts.idFor(key)
    case 'number':
    case 'int':
      return 0
    case 'boolean':
      return false
    case 'enum':
      return Object.values(def.entries as Record<string, unknown>)[0]
    case 'literal':
      return (def.values as unknown[])[0]
    case 'record':
      return Object.fromEntries(opts.pathKeys.map((k) => [k, canary]))
    case 'null':
      return null
    default:
      return opts.opaque(canary)
  }
}
