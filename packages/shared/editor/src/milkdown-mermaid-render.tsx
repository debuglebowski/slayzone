/**
 * Milkdown mermaid render plugin
 *
 * Overrides the code_block NodeView for fences with `language="mermaid"`.
 * Each block has its own Preview/Raw segmented switch:
 *   - preview: rendered diagram via shared MermaidBlock component
 *   - raw:     editable code source (ProseMirror contentDOM)
 *
 * The toolbar and preview host are contentEditable=false (so clicks/zoom-pan
 * inside the rendered diagram don't enter ProseMirror's selection); the
 * underlying <code> contentDOM inherits the editor's contentEditable=true so
 * source edits flow through ProseMirror as normal. Markdown roundtrip is
 * byte-identical.
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import type { Node as ProseNode } from '@milkdown/prose/model'
import type { NodeView } from '@milkdown/prose/view'
import { MermaidBlock } from '@slayzone/markdown/client'

type Mode = 'preview' | 'raw'

function createMermaidCodeBlockView(initialNode: ProseNode): NodeView {
  let currentNode = initialNode
  let mode: Mode = 'preview'

  const dom = document.createElement('div')
  dom.className = 'mk-mermaid'
  dom.dataset.mode = mode

  // ---- Toolbar with segmented switch ------------------------------------
  const toolbar = document.createElement('div')
  toolbar.className = 'mk-mermaid-toolbar'
  toolbar.contentEditable = 'false'

  const segPreview = document.createElement('button')
  segPreview.type = 'button'
  segPreview.className = 'mk-mermaid-seg'
  segPreview.dataset.value = 'preview'
  segPreview.textContent = 'Preview'

  const segRaw = document.createElement('button')
  segRaw.type = 'button'
  segRaw.className = 'mk-mermaid-seg'
  segRaw.dataset.value = 'raw'
  segRaw.textContent = 'Raw'

  toolbar.appendChild(segPreview)
  toolbar.appendChild(segRaw)

  // ---- Preview + source hosts -------------------------------------------
  const previewHost = document.createElement('div')
  previewHost.className = 'mk-mermaid-preview'
  previewHost.contentEditable = 'false'

  const sourceHost = document.createElement('pre')
  sourceHost.className = 'mk-mermaid-source'
  const code = document.createElement('code')
  code.className = 'language-mermaid'
  sourceHost.appendChild(code)

  dom.appendChild(toolbar)
  dom.appendChild(previewHost)
  dom.appendChild(sourceHost)

  // ---- Preview rendering -------------------------------------------------
  let root: Root | null = null

  function renderPreview() {
    if (!root) root = createRoot(previewHost)
    root.render(createElement(MermaidBlock, { code: currentNode.textContent }))
  }

  function unmountPreview() {
    if (!root) return
    const r = root
    root = null
    queueMicrotask(() => {
      try { r.unmount() } catch { /* ignore */ }
    })
  }

  function applyMode() {
    dom.dataset.mode = mode
    segPreview.dataset.active = String(mode === 'preview')
    segRaw.dataset.active = String(mode === 'raw')
    if (mode === 'preview') renderPreview()
    else unmountPreview()
  }

  function setMode(next: Mode) {
    if (mode === next) return
    mode = next
    applyMode()
  }

  // Capture-phase mousedown on the whole toolbar prevents ProseMirror's own
  // mousedown handler (which moves the selection to the click point and may
  // steal focus before the click event resolves on the button).
  toolbar.addEventListener('mousedown', (e) => {
    e.preventDefault()
    e.stopPropagation()
  }, true)
  for (const btn of [segPreview, segRaw]) {
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      setMode((btn.dataset.value as Mode) ?? 'preview')
    })
  }

  applyMode()

  return {
    dom,
    contentDOM: code,
    update(updated: ProseNode): boolean {
      if (updated.type !== currentNode.type) return false
      if (updated.attrs.language !== 'mermaid') return false
      const textChanged = updated.textContent !== currentNode.textContent
      currentNode = updated
      if (mode === 'preview' && textChanged) renderPreview()
      return true
    },
    ignoreMutation(m) {
      const target = m.target as globalThis.Node
      // Only doc edits live inside the source <pre><code>; anything else (wrapper
      // dataset flips, toolbar attribute toggles, React rendering inside the
      // preview host) is chrome and must NOT trip PM's mutation observer — if
      // it did, PM would treat the change as foreign and rebuild the NodeView.
      return !sourceHost.contains(target)
    },
    stopEvent(e) {
      const t = e.target
      if (!(t instanceof Element)) return false
      return previewHost.contains(t) || toolbar.contains(t)
    },
    destroy() {
      unmountPreview()
    },
  }
}

export const mermaidRenderPlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('mermaidCodeBlockView'),
      props: {
        nodeViews: {
          code_block: (node) => {
            if (node.attrs.language !== 'mermaid') return undefined as unknown as NodeView
            return createMermaidCodeBlockView(node)
          },
        },
      },
    }),
)
