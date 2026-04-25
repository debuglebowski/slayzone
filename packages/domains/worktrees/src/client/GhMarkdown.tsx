import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { mermaidCodeOverride } from '@slayzone/markdown/client'

const PROSE_CLASSES = `prose prose-sm dark:prose-invert max-w-none
  [&>*:first-child]:mt-0 [&>*:last-child]:mb-0
  prose-p:my-1.5 prose-p:leading-relaxed
  prose-pre:my-2 prose-pre:text-[11px] prose-pre:rounded-md prose-pre:bg-muted prose-pre:text-foreground
  prose-code:text-[11px] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:bg-muted
  [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:rounded-none
  prose-a:text-primary prose-a:no-underline hover:prose-a:underline
  prose-blockquote:border-l-2 prose-blockquote:pl-3 prose-blockquote:text-muted-foreground prose-blockquote:my-2
  prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5
  prose-img:rounded-md prose-img:my-2
  [&_details]:my-2 [&_details]:rounded-md
  [&_summary]:cursor-pointer [&_summary]:select-none
  [&_summary>h1]:inline [&_summary>h2]:inline [&_summary>h3]:inline [&_summary>h4]:inline
  [&_summary>h1]:my-0 [&_summary>h2]:my-0 [&_summary>h3]:my-0 [&_summary>h4]:my-0
  [&_table]:border [&_table]:border-border [&_table]:rounded-lg [&_table]:overflow-hidden [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:w-auto [&_table]:max-w-full
  [&_thead]:border-b-0
  [&_th]:border-b [&_th]:border-r [&_th]:border-border [&_th]:p-2
  [&_td]:border-b [&_td]:border-r [&_td]:border-border [&_td]:p-2
  [&_th:last-child]:border-r-0 [&_td:last-child]:border-r-0
  [&_tr:last-child_td]:border-b-0`

const components = { code: mermaidCodeOverride }

export function GhMarkdown({ children }: { children: string }) {
  return (
    <div className={PROSE_CLASSES}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
