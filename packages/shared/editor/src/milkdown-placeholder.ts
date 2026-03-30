import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { Decoration, DecorationSet } from '@milkdown/prose/view'

const placeholderKey = new PluginKey('placeholder')

/** Creates a Milkdown plugin that shows placeholder text when the document is empty. */
export function createPlaceholderPlugin(text: string) {
  return $prose(() => {
    return new Plugin({
      key: placeholderKey,
      props: {
        decorations(state) {
          const { doc } = state
          const firstChild = doc.firstChild
          if (doc.childCount > 1 || !firstChild?.isTextblock || firstChild.content.size > 0) {
            return DecorationSet.empty
          }
          return DecorationSet.create(doc, [
            Decoration.node(0, firstChild.nodeSize, {
              class: 'is-editor-empty',
              'data-placeholder': text,
            }),
          ])
        },
      },
    })
  })
}
