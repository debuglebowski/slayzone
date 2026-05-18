import { createElement, type ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { mermaidCodeOverride } from './mermaidCodeOverride'

const baseComponents = { code: mermaidCodeOverride }

const blockTags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'hr', 'img'] as const

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withSourceLine(tag: string): (props: any) => ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Component = ({ node, ...rest }: any): ReactElement =>
    createElement(tag, { 'data-source-line': node?.position?.start?.line, ...rest })
  Component.displayName = `MarkdownSourceLine(${tag})`
  return Component
}

const sourceLineComponents = Object.fromEntries(blockTags.map(t => [t, withSourceLine(t)]))

export function Markdown({ children, attachSourceLines }: { children: string; attachSourceLines?: boolean }) {
  const components = attachSourceLines ? { ...sourceLineComponents, ...baseComponents } : baseComponents
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={components}>
      {children}
    </ReactMarkdown>
  )
}
