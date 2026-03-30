import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'

export const escapeBlurPlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('escapeBlur'),
    props: {
      handleKeyDown(view, event) {
        if (event.key === 'Escape') {
          view.dom.blur()
          return true
        }
        return false
      },
    },
  })
})
