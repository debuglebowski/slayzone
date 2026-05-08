# @slayzone/markdown

Shared markdown helpers consumed by `file-editor`, `worktrees`, and `task` domains.

## Exports

- `MermaidBlock` — pure-React component that lazy-loads mermaid, caches rendered SVGs (FIFO 50, theme-keyed). With `fill` prop, delegates to `CanvasMediaView`.
- `CanvasMediaView` — unified canvas-based viewer for raster images and SVG strings. Rasterizes SVG once at oversample (2×) for crispness, blits with `ctx.drawImage` + `setTransform`. Pan/zoom via pointer/wheel/pinch. Fit + Full buttons.
- `mermaidCodeOverride` — drop-in `code` component override for `react-markdown`. Renders mermaid for `language-mermaid` fences and auto-detects bare fences whose body matches mermaid keywords.
- `MERMAID_KEYWORDS` — exported regex used by `mermaidCodeOverride` for auto-detection.

## Usage

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { mermaidCodeOverride } from '@slayzone/markdown/client'

<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  components={{ code: mermaidCodeOverride }}
>
  {markdown}
</ReactMarkdown>
```

`MermaidBlock` reads the active theme from the `dark` class on `<html>` (no provider needed; works in detached React roots like ProseMirror NodeViews) and re-renders via `MutationObserver` when it flips. Cached SVGs are theme-keyed, so theme changes pull a fresh render.
