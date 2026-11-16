import { findScrollLayout } from './DiffView.scroll'

export interface ListLayout {
  parent: HTMLElement | null
  /** List origin in the ancestor's scroll coordinates, including preceding files/headers. */
  offset: number
}

interface LayoutObserver {
  add(element: HTMLElement, update: () => void): () => void
}
const observers = new WeakMap<HTMLElement, LayoutObserver>()

/** One observer/measurement pass per viewport, shared by all its file lists/columns. */
function viewportObserver(root: HTMLElement): LayoutObserver {
  const existing = observers.get(root)
  if (existing) return existing
  const win = root.ownerDocument.defaultView!
  const members = new Map<HTMLElement, () => void>()
  let observed = new Set<Element>()
  let ancestors = new Set<HTMLElement>()
  const localMutations: MutationObserverInit = {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'open']
  }
  let frame: number | null = null
  let disposed = false
  const schedule = () => {
    if (disposed || frame !== null) return
    frame = win.requestAnimationFrame(() => {
      frame = null
      if (disposed) return
      observeStructure()
      for (const update of [...members.values()]) update()
    })
  }
  const ancestorScroll = (event: Event) => {
    // Native scroll does not bubble. Ignore synthetic scroll from unrelated siblings.
    if (event.target === event.currentTarget) schedule()
  }
  const resize = win.ResizeObserver ? new win.ResizeObserver(schedule) : null
  // Observe structural boxes, not thousands of virtual rows. A preceding sibling
  // can move a list without resizing that list or the fixed-height viewport.
  const observeStructure = () => {
    const next = new Set<Element>([root])
    const parents = new Set<Element>()
    const observeChildren = (parent: Element) => {
      if (parents.has(parent)) return
      parents.add(parent)
      // Never enumerate a virtual list's rows. Its sizer/ancestor boxes cover layout.
      if (parent.firstElementChild?.hasAttribute('data-index')) return
      for (const sibling of parent.children) next.add(sibling)
    }
    for (const element of members.keys()) {
      let current: HTMLElement | null = element
      while (current && current !== root && root.contains(current)) {
        next.add(current)
        const parent: HTMLElement | null = current.parentElement
        if (parent) observeChildren(parent)
        current = parent
      }
    }
    // The selected root may be an expanding fallback wrapper. Keep its ancestor
    // boxes and scroll/style signals alive so local resize can select an outer root.
    const nextAncestors = new Set<HTMLElement>()
    let scope: HTMLElement | null = null
    for (let parent = root.parentElement; parent; parent = parent.parentElement) {
      nextAncestors.add(parent)
      next.add(parent)
      const overflow = win.getComputedStyle(parent).overflowY
      if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') scope = parent
    }
    // A preceding file can create overflow without resizing the viewport itself.
    // Observe flow boxes through scroll candidates, not unrelated page subtrees.
    if (scope) {
      for (let parent = root.parentElement; parent; parent = parent.parentElement) {
        observeChildren(parent)
        if (parent === scope) break
      }
    }
    if (
      nextAncestors.size !== ancestors.size ||
      [...nextAncestors].some((node) => !ancestors.has(node))
    ) {
      for (const node of ancestors)
        if (!nextAncestors.has(node)) node.removeEventListener('scroll', ancestorScroll)
      for (const node of nextAncestors)
        if (!ancestors.has(node)) node.addEventListener('scroll', ancestorScroll, { passive: true })
      ancestors = nextAncestors
      mutations.disconnect()
      mutations.observe(root, localMutations)
      for (const node of ancestors) mutations.observe(node, { attributes: true, childList: true })
    }
    for (const element of observed) if (!next.has(element)) resize?.unobserve(element)
    for (const element of next) if (!observed.has(element)) resize?.observe(element)
    observed = next
  }
  const mutations = new win.MutationObserver((records) => {
    const structural = records.some((record) => {
      const target =
        record.target instanceof win.Element ? record.target : record.target.parentElement
      if (ancestors.has(target as HTMLElement)) return true
      // Absolute row mount/position/highlight changes do not move their list.
      // Their real height changes are already measured by TanStack's row observer.
      if (resize && record.type === 'childList' && members.has(target as HTMLElement)) return false
      const row = target?.closest('[data-index]')
      return !resize || !row || !members.has(row.parentElement as HTMLElement)
    })
    if (structural) schedule()
  })
  mutations.observe(root, localMutations)
  root.addEventListener('scroll', schedule, { passive: true })
  win.addEventListener('resize', schedule)
  const fonts = root.ownerDocument.fonts
  fonts?.addEventListener('loadingdone', schedule)
  const observer: LayoutObserver = {
    add(element, update) {
      members.set(element, update)
      // Batch structural observation across mounts/unmounts too: Activity can
      // detach every file in one commit, which must not rescan all files per ref.
      schedule()
      return () => {
        members.delete(element)
        if (members.size) {
          schedule()
          return
        }
        disposed = true
        if (frame !== null) win.cancelAnimationFrame(frame)
        resize?.disconnect()
        mutations.disconnect()
        root.removeEventListener('scroll', schedule)
        for (const node of ancestors) node.removeEventListener('scroll', ancestorScroll)
        ancestors.clear()
        observed.clear()
        win.removeEventListener('resize', schedule)
        fonts?.removeEventListener('loadingdone', schedule)
        observers.delete(root)
      }
    }
  }
  observers.set(root, observer)
  return observer
}

/** Active-effect resource: reacquire on Activity replay and fence queued old callbacks. */
export function observeListLayout(
  element: HTMLElement,
  notify: (layout: ListLayout) => void
): () => void {
  let active = true
  let root: HTMLElement | null = null
  let release: (() => void) | undefined
  const update = () => {
    if (!active) return
    const layout = findScrollLayout(element)
    const nextRoot = layout?.parent ?? element.parentElement ?? element
    if (nextRoot !== root) {
      release?.()
      root = nextRoot
      release = viewportObserver(root).add(element, update)
    }
    const parent = layout && !layout.nested ? layout.parent : null
    const offset = parent
      ? element.getBoundingClientRect().top -
        parent.getBoundingClientRect().top -
        parent.clientTop +
        parent.scrollTop
      : 0
    notify({ parent, offset })
  }
  update()
  return () => {
    active = false
    release?.()
  }
}
