import { Extension, type Editor } from '@tiptap/react'
import { Fragment } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'

const LIST_ITEM_TYPES = ['listItem', 'taskItem']

function moveListItem(editor: Editor, direction: 'up' | 'down'): boolean {
  const { state } = editor
  const { $from } = state.selection

  // Find the closest list item ancestor
  let depth: number | null = null
  for (let d = $from.depth; d > 0; d--) {
    if (LIST_ITEM_TYPES.includes($from.node(d).type.name)) {
      depth = d
      break
    }
  }
  if (depth === null) return false

  const parent = $from.node(depth - 1)
  const itemIndex = $from.index(depth - 1)

  // Boundary check
  if (direction === 'up' && itemIndex === 0) return false
  if (direction === 'down' && itemIndex === parent.childCount - 1) return false

  // Compute positions of all children in the parent list
  const parentContentStart = $from.start(depth - 1)
  const positions: { from: number; to: number }[] = []
  parent.forEach((child, offset) => {
    positions.push({
      from: parentContentStart + offset,
      to: parentContentStart + offset + child.nodeSize,
    })
  })

  const targetIndex = direction === 'up' ? itemIndex - 1 : itemIndex + 1
  const currentPos = positions[itemIndex]
  const targetPos = positions[targetIndex]

  const rangeFrom = Math.min(currentPos.from, targetPos.from)
  const rangeTo = Math.max(currentPos.to, targetPos.to)

  const currentNode = parent.child(itemIndex)
  const targetNode = parent.child(targetIndex)

  // Build swapped fragment
  const swapped =
    direction === 'up'
      ? Fragment.from([currentNode, targetNode])
      : Fragment.from([targetNode, currentNode])

  const { tr } = state
  tr.replaceWith(rangeFrom, rangeTo, swapped)

  // Restore cursor position inside the moved item
  const offsetInItem = $from.pos - currentPos.from
  const newItemStart = direction === 'up' ? rangeFrom : rangeFrom + targetNode.nodeSize
  const newPos = Math.min(newItemStart + offsetInItem, tr.doc.content.size - 1)
  tr.setSelection(TextSelection.create(tr.doc, newPos))

  editor.view.dispatch(tr)
  return true
}

export const ListItemMove = Extension.create({
  name: 'listItemMove',

  addKeyboardShortcuts() {
    return {
      'Alt-ArrowUp': () => moveListItem(this.editor, 'up'),
      'Alt-ArrowDown': () => moveListItem(this.editor, 'down'),
    }
  },
})
