import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { MermaidBlock } from './MermaidBlock'

export const MERMAID_KEYWORDS =
  /^%%\{|^(classDiagram|flowchart|sequenceDiagram|stateDiagram|erDiagram|gantt|pie|graph\s|gitGraph|mindmap|timeline|sankey|xychart|block-beta|journey|quadrantChart|requirementDiagram|C4Context|C4Container|C4Component|C4Deployment)\b/

type CodeProps = ComponentPropsWithoutRef<'code'>

function flatten(children: ReactNode): string {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(flatten).join('')
  return ''
}

export function mermaidCodeOverride(props: CodeProps) {
  const { className, children, ...rest } = props
  const text = flatten(children)
  const isMermaidClass = className === 'language-mermaid'
  const isAutoDetected = !className && text.includes('\n') && MERMAID_KEYWORDS.test(text.trim())
  if (isMermaidClass || isAutoDetected) {
    return <MermaidBlock code={text.replace(/\n$/, '')} />
  }
  return (
    <code className={className} {...rest}>
      {children}
    </code>
  )
}
