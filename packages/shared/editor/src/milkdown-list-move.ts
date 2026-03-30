import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey, TextSelection } from '@milkdown/prose/state'
import { Fragment } from '@milkdown/prose/model'
import type { EditorState } from '@milkdown/prose/state'
import type { EditorView } from '@milkdown/prose/view'

const LIST_ITEM_TYPES = ['list_item']

function moveListItem(state: EditorState, dispatch: EditorView['dispatch'] | undefined, direction: 'up' | 'down'): boolean {
  const { $from } = state.selection

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

  if (direction === 'up' && itemIndex === 0) return false
  if (direction === 'down' && itemIndex === parent.childCount - 1) return false

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

  const swapped =
    direction === 'up'
      ? Fragment.from([currentNode, targetNode])
      : Fragment.from([targetNode, currentNode])

  if (dispatch) {
    const { tr } = state
    tr.replaceWith(rangeFrom, rangeTo, swapped)
    const offsetInItem = $from.pos - currentPos.from
    const newItemStart = direction === 'up' ? rangeFrom : rangeFrom + targetNode.nodeSize
    const newPos = Math.min(newItemStart + offsetInItem, newItemStart + currentNode.nodeSize - 1)
    tr.setSelection(TextSelection.create(tr.doc, newPos))
    dispatch(tr)
  }
  return true
}

export const listItemMovePlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('listItemMove'),
    props: {
      handleKeyDown(view, event) {
        if (!event.altKey) return false
        if (event.key === 'ArrowUp') return moveListItem(view.state, view.dispatch, 'up')
        if (event.key === 'ArrowDown') return moveListItem(view.state, view.dispatch, 'down')
        return false
      },
    },
  })
})
