import { createElement, type ReactElement } from 'react'
import ReactMarkdown, { type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { mermaidCodeOverride } from './mermaidCodeOverride'

const baseComponents = { code: mermaidCodeOverride }

const blockTags = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'hr',
  'img'
] as const

// `tag` is only known at runtime, so its intrinsic attributes can't be named here.
// We read the hast `node` react-markdown passes (for the source line) and forward
// every other attribute verbatim, hence the open record.
type SourceLineProps = ExtraProps & Record<string, unknown>

function withSourceLine(tag: string): (props: SourceLineProps) => ReactElement {
  const Component = ({ node, ...rest }: SourceLineProps): ReactElement =>
    createElement(tag, { 'data-source-line': node?.position?.start?.line, ...rest })
  Component.displayName = `MarkdownSourceLine(${tag})`
  return Component
}

const sourceLineComponents = Object.fromEntries(blockTags.map((t) => [t, withSourceLine(t)]))

export function Markdown({
  children,
  attachSourceLines
}: {
  children: string
  attachSourceLines?: boolean
}) {
  const components = attachSourceLines
    ? { ...sourceLineComponents, ...baseComponents }
    : baseComponents
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={components}>
      {children}
    </ReactMarkdown>
  )
}
