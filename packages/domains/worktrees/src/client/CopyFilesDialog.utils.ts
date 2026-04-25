import type { IgnoredFileNode } from '../shared/types'

export type NodeState = 'checked' | 'indeterminate' | 'unchecked'

export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\0/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/**
 * Resolve preset globs against the ignored-file tree.
 *
 * Returns a set of "selection roots" — paths whose subtree should be copied.
 *
 * Invariant: no ancestor and descendant appear together. Once a directory is
 * matched (via a multi-segment glob), descendants are never added separately
 * even when they would also match a basename glob. The single-pass walk carries
 * an `ancestorMatched` flag down so basename matches inside an already-matched
 * directory collapse into the ancestor's subtree copy.
 *
 * - Single-segment globs (`.env*`, `*.md`) match a file's basename at any depth.
 * - Multi-segment globs (`docs/**`) match the top-level dir by first segment only.
 */
export function filterTreeByGlobs(nodes: IgnoredFileNode[], globs: string[]): Set<string> {
  if (globs.length === 0) return new Set(nodes.map(n => n.path))

  const basenameMatchers: RegExp[] = []
  const dirPrefixes: string[] = []
  for (const glob of globs) {
    const firstSlash = glob.indexOf('/')
    if (firstSlash === -1) basenameMatchers.push(globToRegex(glob))
    else dirPrefixes.push(glob.slice(0, firstSlash))
  }

  const matched = new Set<string>()
  const walk = (node: IgnoredFileNode, depth: number, ancestorMatched: boolean): void => {
    // Dir globs match top-level only (depth 0). Basename globs match files at any depth
    // — but skip when an ancestor is already matched, otherwise a parent dir + descendant
    // file would both end up as selection roots, violating the no-overlap invariant.
    const selfDirMatch = !ancestorMatched && depth === 0 && node.isDirectory && dirPrefixes.includes(node.name)
    if (selfDirMatch) matched.add(node.path)
    const nowMatched = ancestorMatched || selfDirMatch
    if (!nowMatched && !node.isDirectory && basenameMatchers.some(re => re.test(node.name))) {
      matched.add(node.path)
    }
    for (const c of node.children) walk(c, depth + 1, nowMatched)
  }
  for (const n of nodes) walk(n, 0, false)
  return matched
}

/**
 * Compute per-node checkbox state + the total number of files covered.
 * Selection model: `selected` is a set of "selection roots" — either a file path
 * or a dir path meaning the whole subtree is copied. Invariant: no ancestor and
 * descendant appear together (enforced by `filterTreeByGlobs` and `toggle`).
 */
export function computeStates(tree: IgnoredFileNode[], selected: Set<string>): {
  states: Map<string, NodeState>
  selectedCounts: Map<string, number>
  selectedFileCount: number
} {
  const states = new Map<string, NodeState>()
  const selectedCounts = new Map<string, number>()
  let selectedFileCount = 0

  const walk = (node: IgnoredFileNode, ancestorSelected: boolean): { state: NodeState; count: number } => {
    const inherited = ancestorSelected || selected.has(node.path)
    if (!node.isDirectory) {
      const st: NodeState = inherited ? 'checked' : 'unchecked'
      states.set(node.path, st)
      const count = inherited ? 1 : 0
      selectedCounts.set(node.path, count)
      if (inherited) selectedFileCount += 1
      return { state: st, count }
    }
    let total = 0
    let anyChecked = false
    let anyUnchecked = false
    let anyIndeterminate = false
    for (const c of node.children) {
      const r = walk(c, inherited)
      total += r.count
      if (r.state === 'checked') anyChecked = true
      else if (r.state === 'unchecked') anyUnchecked = true
      else anyIndeterminate = true
    }
    let st: NodeState
    if (inherited) st = 'checked'
    else if (anyIndeterminate || (anyChecked && anyUnchecked)) st = 'indeterminate'
    else if (anyChecked) st = 'checked'
    else st = 'unchecked'
    states.set(node.path, st)
    selectedCounts.set(node.path, total)
    return { state: st, count: total }
  }

  for (const n of tree) walk(n, false)
  return { states, selectedCounts, selectedFileCount }
}

/** Return chain of nodes from top-level ancestor down to the target (inclusive). */
export function findChain(tree: IgnoredFileNode[], targetPath: string): IgnoredFileNode[] | null {
  for (const node of tree) {
    if (node.path === targetPath) return [node]
    if (targetPath.startsWith(node.path + '/')) {
      const sub = findChain(node.children, targetPath)
      if (sub) return [node, ...sub]
    }
  }
  return null
}

export function removeSubtree(node: IgnoredFileNode, set: Set<string>): void {
  set.delete(node.path)
  for (const c of node.children) removeSubtree(c, set)
}
