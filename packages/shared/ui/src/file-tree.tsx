import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, ChevronDown, Folder, FolderOpen } from 'lucide-react'
import { cn } from './utils'

// --- Tree types ---

export interface TreeFolder<T> {
  type: 'folder'
  name: string
  path: string
  children: TreeNode<T>[]
}

export interface TreeFile<T> {
  type: 'file'
  name: string
  item: T
}

export type TreeNode<T> = TreeFolder<T> | TreeFile<T>

// --- Tree building ---

/**
 * Intermediate structure while inserting paths: a directory is a nested Map,
 * a file is the item itself. Only ever lives inside `buildFileTree`.
 */
type PathMap<T> = Map<string, PathMap<T> | T>

export function buildFileTree<T>(
  items: T[],
  getPath: (item: T) => string,
  options?: { compress?: boolean }
): TreeNode<T>[] {
  // `T` is unconstrained, so the Map check is what separates a directory from a
  // leaf. A type predicate (rather than a bare `instanceof`) is what lets TS
  // narrow the `PathMap<T> | T` union down to `T` on the else branch.
  const isDir = (value: unknown): value is PathMap<T> => value instanceof Map

  const root: PathMap<T> = new Map()
  for (const item of items) {
    const parts = getPath(item).split('/')
    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current.has(parts[i])) current.set(parts[i], new Map())
      const next = current.get(parts[i])
      if (isDir(next)) current = next
      else break
    }
    current.set(parts[parts.length - 1], item)
  }

  function toNodes(map: PathMap<T>, prefix: string): TreeNode<T>[] {
    const dirs: TreeFolder<T>[] = []
    const files: TreeFile<T>[] = []
    for (const [name, value] of map) {
      if (isDir(value)) {
        const dirPath = prefix ? `${prefix}/${name}` : name
        dirs.push({ type: 'folder', name, path: dirPath, children: toNodes(value, dirPath) })
      } else {
        files.push({ type: 'file', name, item: value })
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name))
    files.sort((a, b) => a.name.localeCompare(b.name))
    return [...dirs, ...files]
  }

  const nodes = toNodes(root, '')
  return options?.compress ? compressTree(nodes) : nodes
}

/** Merge single-child directory chains into "a/b/c" labels */
function compressTree<T>(nodes: TreeNode<T>[]): TreeNode<T>[] {
  return nodes.map((node) => {
    if (node.type === 'file') return node
    let n = node
    while (n.children.length === 1 && n.children[0].type === 'folder') {
      const child = n.children[0] as TreeFolder<T>
      n = {
        type: 'folder',
        name: `${n.name}/${child.name}`,
        path: child.path,
        children: child.children
      }
    }
    return { ...n, children: compressTree(n.children) }
  })
}

/** Flatten tree to items respecting collapsed folders */
export function flattenFileTree<T>(nodes: TreeNode<T>[], collapsed: Set<string>): T[] {
  const result: T[] = []
  for (const node of nodes) {
    if (node.type === 'file') {
      result.push(node.item)
    } else if (!collapsed.has(node.path)) {
      result.push(...flattenFileTree(node.children, collapsed))
    }
  }
  return result
}

// --- Components ---

const INDENT_PX = 20
const BASE_PAD = 4

function FolderRow({
  name,
  expanded,
  depth,
  onClick,
  actions
}: {
  name: string
  expanded: boolean
  depth: number
  onClick: () => void
  actions?: ReactNode
}) {
  return (
    <button
      className="group/folder flex w-full select-none items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-muted/50"
      style={{ paddingLeft: depth * INDENT_PX + BASE_PAD }}
      onClick={onClick}
    >
      <span className="relative size-4 shrink-0">
        {expanded ? (
          <FolderOpen className="size-4 text-muted-foreground transition-opacity group-hover/folder:opacity-0" />
        ) : (
          <Folder className="size-4 text-muted-foreground transition-opacity group-hover/folder:opacity-0" />
        )}
        {expanded ? (
          <ChevronDown className="absolute inset-0 m-auto size-3 opacity-0 transition-opacity group-hover/folder:opacity-100" />
        ) : (
          <ChevronRight className="absolute inset-0 m-auto size-3 opacity-0 transition-opacity group-hover/folder:opacity-100" />
        )}
      </span>
      <span className="truncate font-mono flex-1 text-left">{name}</span>
      {actions}
    </button>
  )
}

function TreeBranch<T>({
  nodes,
  depth,
  expandedFolders,
  onToggleFolder,
  renderFile,
  folderActions
}: {
  nodes: TreeNode<T>[]
  depth: number
  expandedFolders: Set<string>
  onToggleFolder: (path: string) => void
  renderFile: (item: T, info: { name: string; depth: number }) => ReactNode
  folderActions?: (folder: { name: string; path: string }) => ReactNode
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.type === 'folder') {
          const expanded = expandedFolders.has(node.path)
          return (
            <div key={`d:${node.path}`}>
              <FolderRow
                name={node.name}
                expanded={expanded}
                depth={depth}
                onClick={() => onToggleFolder(node.path)}
                actions={folderActions?.({ name: node.name, path: node.path })}
              />
              {expanded && (
                <TreeBranch
                  nodes={node.children}
                  depth={depth + 1}
                  expandedFolders={expandedFolders}
                  onToggleFolder={onToggleFolder}
                  renderFile={renderFile}
                  folderActions={folderActions}
                />
              )}
            </div>
          )
        }
        return <div key={`f:${node.name}`}>{renderFile(node.item, { name: node.name, depth })}</div>
      })}
    </>
  )
}

export interface FileTreeProps<T> {
  /** Items to display in the tree */
  items: T[]
  /** Extract the slash-separated path from each item */
  getPath: (item: T) => string
  /** Render a file leaf node */
  renderFile: (item: T, info: { name: string; depth: number }) => ReactNode
  /** Extra actions rendered inside each folder row (e.g. stage/unstage buttons) */
  folderActions?: (folder: { name: string; path: string }) => ReactNode
  /** Merge single-child directory chains (e.g. "a/b/c") */
  compress?: boolean
  /** Controlled expanded folders state */
  expandedFolders?: Set<string>
  /** Controlled toggle handler */
  onToggleFolder?: (path: string) => void
  /** Start with all folders expanded (only for uncontrolled mode) */
  defaultExpanded?: boolean
  className?: string
}

export function FileTree<T>({
  items,
  getPath,
  renderFile,
  folderActions,
  compress,
  expandedFolders: controlledExpanded,
  onToggleFolder: controlledToggle,
  defaultExpanded,
  className
}: FileTreeProps<T>) {
  const tree = useMemo(
    () => buildFileTree(items, getPath, { compress }),
    [items, getPath, compress]
  )

  // Collect all folder paths for defaultExpanded
  const allFolderPaths = useMemo(() => {
    if (!defaultExpanded) return new Set<string>()
    const paths = new Set<string>()
    function walk(nodes: TreeNode<T>[]) {
      for (const n of nodes) {
        if (n.type === 'folder') {
          paths.add(n.path)
          walk(n.children)
        }
      }
    }
    walk(tree)
    return paths
  }, [defaultExpanded, tree])

  const [internalExpanded, setInternalExpanded] = useState<Set<string>>(() =>
    defaultExpanded ? new Set(allFolderPaths) : new Set()
  )

  const isControlled = controlledExpanded !== undefined
  const expandedFolders = isControlled ? controlledExpanded : internalExpanded

  const toggleFolder = useCallback(
    (path: string) => {
      if (controlledToggle) {
        controlledToggle(path)
        return
      }
      setInternalExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })
    },
    [controlledToggle]
  )

  if (tree.length === 0) return null

  return (
    <div className={cn('select-none text-sm', className)}>
      <TreeBranch
        nodes={tree}
        depth={0}
        expandedFolders={expandedFolders}
        onToggleFolder={toggleFolder}
        renderFile={renderFile}
        folderActions={folderActions}
      />
    </div>
  )
}

/** Indent padding for file items to align with folder content */
export function fileTreeIndent(depth: number): number {
  return depth * INDENT_PX + BASE_PAD
}
