# @slayzone/markdown

Shared markdown helpers consumed by `file-editor`, `worktrees`, and `task` domains.

## Exports

- `MermaidBlock` — pure-React component that lazy-loads mermaid, caches rendered SVGs (FIFO 50, theme-keyed), and overlays pan/zoom/fit-width/copy-as-image controls.
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

`MermaidBlock` reads the active theme from `@slayzone/settings/client` `useTheme()`; cached SVGs are invalidated on theme change.
