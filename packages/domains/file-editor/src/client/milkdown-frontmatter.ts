/**
 * Milkdown frontmatter plugin
 *
 * Parses YAML frontmatter (--- delimited blocks) via remark-frontmatter,
 * renders as an editable code block in the editor, and serializes back
 * to --- delimited YAML on output.
 *
 * Compatible with @milkdown/core v7.19.2 (no @milkdown/kit dependency).
 */
import type { MilkdownPlugin } from '@milkdown/ctx'
import { $nodeSchema, $remark, $view } from '@milkdown/utils'
import remarkFrontmatter from 'remark-frontmatter'

// ---------------------------------------------------------------------------
// 1. Remark plugin — teaches the unified pipeline to parse/stringify `yaml` nodes
// ---------------------------------------------------------------------------

export const remarkFrontmatterPlugin = $remark('remarkFrontmatter', () => remarkFrontmatter, ['yaml'])

// ---------------------------------------------------------------------------
// 2. Node schema — bridges the mdast `yaml` node to ProseMirror
// ---------------------------------------------------------------------------

export const frontmatterSchema = $nodeSchema('frontmatter', () => ({
  group: 'block',
  atom: true,
  isolating: true,
  selectable: true,
  attrs: {
    value: { default: '' },
  },

  parseMarkdown: {
    match: (node) => node.type === 'yaml',
    runner: (state, node, type) => {
      state.addNode(type, { value: (node.value as string) ?? '' })
    },
  },

  toMarkdown: {
    match: (node) => node.type.name === 'frontmatter',
    runner: (state, node) => {
      state.addNode('yaml', undefined, node.attrs.value as string)
    },
  },

  // DOM round-trip (copy/paste)
  parseDOM: [
    {
      tag: 'div[data-type="frontmatter"]',
      getAttrs: (dom) => ({
        value: (dom as HTMLElement).dataset.value ?? '',
      }),
    },
  ],
  toDOM: (node) => [
    'div',
    { 'data-type': 'frontmatter', 'data-value': node.attrs.value },
  ],
}))

// ---------------------------------------------------------------------------
// 3. Node view — renders an editable <textarea> for the raw YAML
// ---------------------------------------------------------------------------

export const frontmatterView = $view(frontmatterSchema.node, () => {
  return (initialNode, view, getPos) => {
    let currentNode = initialNode

    // Read CSS custom properties from the editor root for theme-aware colors
    const cs = getComputedStyle(view.dom)
    const fg = cs.getPropertyValue('color') || 'currentColor'
    // Use currentColor-relative opacity via color-mix for theme adaptability
    const border = `color-mix(in srgb, ${fg} 12%, transparent)`
    const bgSubtle = `color-mix(in srgb, ${fg} 4%, transparent)`
    const bgHeader = `color-mix(in srgb, ${fg} 6%, transparent)`
    const borderLight = `color-mix(in srgb, ${fg} 8%, transparent)`
    const textMuted = `color-mix(in srgb, ${fg} 40%, transparent)`
    const textDimmed = `color-mix(in srgb, ${fg} 50%, transparent)`

    // Outer wrapper — inline styles to avoid Tailwind prose overrides
    const dom = document.createElement('div')
    dom.setAttribute('data-type', 'frontmatter')
    Object.assign(dom.style, {
      marginBottom: '1.5rem',
      border: `1px solid ${border}`,
      borderRadius: '8px',
      background: bgSubtle,
      overflow: 'hidden',
      padding: '0',
    })

    // Header label
    const header = document.createElement('div')
    Object.assign(header.style, {
      padding: '6px 12px',
      fontSize: '0.65rem',
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      color: textMuted,
      background: bgHeader,
      borderBottom: `1px solid ${borderLight}`,
      userSelect: 'none',
    })
    header.textContent = 'Frontmatter'
    dom.appendChild(header)

    // Editable textarea for raw YAML
    const textarea = document.createElement('textarea')
    Object.assign(textarea.style, {
      display: 'block',
      width: '100%',
      boxSizing: 'border-box',
      minHeight: '3em',
      padding: '8px 12px',
      margin: '0',
      border: 'none',
      outline: 'none',
      background: 'transparent',
      color: textDimmed,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '0.75rem',
      lineHeight: '1.6',
      resize: 'none',
      overflow: 'hidden',
    })
    textarea.spellcheck = false
    textarea.value = (currentNode.attrs.value as string) ?? ''
    dom.appendChild(textarea)

    // Auto-resize textarea height to fit content
    function autoResize() {
      textarea.style.height = 'auto'
      textarea.style.height = textarea.scrollHeight + 'px'
    }

    // Commit textarea value to ProseMirror state
    function commitValue() {
      const newValue = textarea.value
      if (newValue === currentNode.attrs.value) return
      const pos = typeof getPos === 'function' ? getPos() : undefined
      if (pos == null) return
      const tr = view.state.tr.setNodeMarkup(pos, undefined, {
        ...currentNode.attrs,
        value: newValue,
      })
      view.dispatch(tr)
    }

    textarea.addEventListener('input', () => {
      autoResize()
      commitValue()
    })

    // Initial sizing (after next frame so DOM is measured)
    requestAnimationFrame(autoResize)

    return {
      dom,
      // No contentDOM — atom node, ProseMirror won't try to render children
      update(updatedNode) {
        if (updatedNode.type.name !== 'frontmatter') return false
        currentNode = updatedNode
        const val = (updatedNode.attrs.value as string) ?? ''
        if (textarea.value !== val) {
          textarea.value = val
          autoResize()
        }
        return true
      },
      selectNode() {
        dom.classList.add('ProseMirror-selectednode')
        textarea.focus()
      },
      deselectNode() {
        dom.classList.remove('ProseMirror-selectednode')
      },
      // Let the textarea handle its own events (typing, selection, etc.)
      stopEvent(e: Event) {
        const target = e.target as HTMLElement | null
        return target === textarea
      },
      ignoreMutation() {
        return true
      },
      destroy() {
        // nothing to clean up
      },
    }
  }
})

// ---------------------------------------------------------------------------
// 4. Bundled plugin array — `.use(frontmatterPlugin)` in the editor
// ---------------------------------------------------------------------------

export const frontmatterPlugin: MilkdownPlugin[] = [
  ...remarkFrontmatterPlugin,
  ...frontmatterSchema,
  frontmatterView,
]
