import { editorViewCtx, commandsCtx } from '@milkdown/core'
import { wrapInBulletListCommand } from '@milkdown/preset-commonmark'
import { $command } from '@milkdown/utils'

// Toggle task list: if in list item, toggle checked attr; otherwise wrap in bullet list
export const toggleTaskListCommand = $command('ToggleTaskList', (ctx) => {
  return () => (state, dispatch) => {
    const { $from } = state.selection
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d)
      if (node.type.name === 'list_item') {
        if (dispatch) {
          const pos = $from.before(d)
          const checked = node.attrs.checked != null ? null : false
          dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked }))
        }
        return true
      }
    }
    // Not in a list — wrap in bullet list as fallback
    const commands = ctx.get(commandsCtx)
    const wrapped = commands.call(wrapInBulletListCommand.key)
    if (wrapped) {
      // Now set checked on the newly created list item
      const view = ctx.get(editorViewCtx)
      const newState = view.state
      const { $from: $newFrom } = newState.selection
      for (let d = $newFrom.depth; d > 0; d--) {
        if ($newFrom.node(d).type.name === 'list_item') {
          const pos = $newFrom.before(d)
          view.dispatch(
            newState.tr.setNodeMarkup(pos, undefined, { ...$newFrom.node(d).attrs, checked: false })
          )
          break
        }
      }
    }
    return wrapped
  }
})
