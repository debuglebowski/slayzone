import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'
import type { Node } from '@milkdown/prose/model'

/**
 * ProseMirror node view that renders an <input type="checkbox"> for
 * Milkdown GFM task list items (li[data-item-type="task"]).
 */
function createTaskListItemView(node: Node, view: EditorView, getPos: () => number | undefined) {
  let currentNode = node

  const dom = document.createElement('li')
  dom.dataset.itemType = 'task'
  dom.dataset.listType = 'bullet'
  dom.dataset.checked = String(node.attrs.checked ?? false)
  if (node.attrs.spread != null) dom.dataset.spread = String(node.attrs.spread)
  if (node.attrs.label) dom.dataset.label = node.attrs.label

  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = node.attrs.checked === true
  checkbox.contentEditable = 'false'
  checkbox.addEventListener('click', (e) => {
    // Use click instead of mousedown so the native checkbox toggles visually first
    const pos = getPos()
    if (pos == null) return
    e.preventDefault()
    const checked = !currentNode.attrs.checked
    // Immediately update visual state
    checkbox.checked = checked
    dom.dataset.checked = String(checked)
    // Dispatch to ProseMirror
    const { tr } = view.state
    view.dispatch(tr.setNodeMarkup(pos, undefined, { ...currentNode.attrs, checked }))
  })

  const contentDOM = document.createElement('span')

  dom.appendChild(checkbox)
  dom.appendChild(contentDOM)

  return {
    dom,
    contentDOM,
    update(updatedNode: Node): boolean {
      if (updatedNode.type !== currentNode.type) return false
      if (updatedNode.attrs.checked == null) return false
      currentNode = updatedNode
      checkbox.checked = updatedNode.attrs.checked === true
      dom.dataset.checked = String(updatedNode.attrs.checked)
      return true
    }
  }
}

export const taskListPlugin = $prose(() => new Plugin({
  key: new PluginKey('taskListCheckbox'),
  props: {
    nodeViews: {
      list_item: (node, view, getPos) => {
        if (node.attrs.checked != null) {
          return createTaskListItemView(node, view, getPos as () => number | undefined)
        }
        // Return null to use default rendering for non-task list items
        return null as never
      }
    }
  }
}))
