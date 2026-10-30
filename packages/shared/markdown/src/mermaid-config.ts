/**
 * How SlayZone renders mermaid diagrams, DOM-free so every renderer shares it: desktop
 * (`MermaidBlock`, the editor's mermaid fences) and the phone's artifact pages, which run
 * the same mermaid build inside a web view.
 */

/** A fenced code block in this language is drawn as a diagram (```` ```mermaid ````). */
export const MERMAID_FENCE_LANGUAGE = 'mermaid'

export interface MermaidInitOptions {
  startOnLoad: false
  theme: 'dark' | 'default'
  securityLevel: 'strict'
  layout: 'dagre'
}

/**
 * `mermaid.initialize` options for the app's light/dark variant. `layout: 'dagre'`:
 * mermaid 12 lays out flowchart/state/class/ER diagrams with ELK by default; dagre keeps
 * them looking as they always have (and as artifact exports render).
 */
export function mermaidInitOptions(variant: 'dark' | 'light'): MermaidInitOptions {
  return {
    startOnLoad: false,
    theme: variant === 'dark' ? 'dark' : 'default',
    securityLevel: 'strict',
    layout: 'dagre'
  }
}
