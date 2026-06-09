import { useCallback, useEffect, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { getThemeEditorColors } from '@slayzone/ui'
import {
  RichTextEditor,
  getEditorViewDOM,
  type Editor as MilkdownEditor
} from '@slayzone/editor'
import { toSlzFileUrl, SLZ_FILE_PREFIX } from '@slayzone/platform/slz-file-url'
import {
  MARKDOWN_FILE_TEXT_EXTENSIONS,
  posixDirname,
  posixResolve
} from './FileEditorView.utils'

export interface MarkdownFilePaneHandle {
  scrollToHeadingIndex: (index: number) => void
  focus: () => void
}

interface MarkdownFilePaneProps {
  filePath: string
  projectPath: string
  content: string
  onChange: (content: string) => void
  onSave: () => void
  onOpenFile: (filePath: string) => void
  themeColors: ReturnType<typeof getThemeEditorColors>
  readability: 'compact' | 'normal'
  width: 'narrow' | 'wide'
  fontFamily: 'sans' | 'mono'
  handleRef?: React.MutableRefObject<MarkdownFilePaneHandle | null>
}

export function MarkdownFilePane({
  filePath,
  projectPath,
  content,
  onChange,
  onSave,
  onOpenFile,
  themeColors,
  readability,
  width,
  fontFamily,
  handleRef
}: MarkdownFilePaneProps) {
  const trpc = useTRPC()
  const openExternalMutation = useMutation(trpc.app.shell.openExternal.mutationOptions())
  const openPathMutation = useMutation(trpc.app.shell.openPath.mutationOptions())
  const editorRef = useRef<MilkdownEditor | null>(null)
  useEffect(() => {
    if (!handleRef) return
    handleRef.current = {
      scrollToHeadingIndex: (index: number) => {
        const root = editorRef.current ? getEditorViewDOM(editorRef.current) : null
        if (!root) return
        const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6')
        const target = headings[index] as HTMLElement | undefined
        target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      },
      focus: () => {
        const root = editorRef.current ? getEditorViewDOM(editorRef.current) : null
        root?.focus()
      }
    }
    return () => {
      if (handleRef) handleRef.current = null
    }
  }, [handleRef])
  const fileDirAbs = posixResolve(projectPath, posixDirname(filePath))

  const resolveSrc = useCallback(
    (src: string): string => {
      if (src.startsWith('/')) return toSlzFileUrl(src)
      return toSlzFileUrl(posixResolve(fileDirAbs, src))
    },
    [fileDirAbs]
  )

  const handleLinkClick = useCallback(
    (resolvedHref: string) => {
      if (!resolvedHref) return
      if (resolvedHref.startsWith('#')) {
        const id = resolvedHref.slice(1)
        const root = editorRef.current ? getEditorViewDOM(editorRef.current) : null
        const el = id ? (root ?? document).querySelector(`#${CSS.escape(id)}`) : null
        el?.scrollIntoView({ block: 'center' })
        return
      }
      if (/^(https?:|mailto:)/i.test(resolvedHref)) {
        void openExternalMutation.mutateAsync({ url: resolvedHref })
        return
      }
      if (resolvedHref.startsWith(SLZ_FILE_PREFIX)) {
        const absPath = resolvedHref
          .slice(SLZ_FILE_PREFIX.length)
          .replace(/\?.*$/, '')
          .replace(/#.*$/, '')
        const projectPrefix = projectPath.endsWith('/') ? projectPath : projectPath + '/'
        if (absPath.startsWith(projectPrefix)) {
          const relPath = absPath.slice(projectPrefix.length)
          const ext = relPath.split('.').pop()?.toLowerCase() ?? ''
          if (MARKDOWN_FILE_TEXT_EXTENSIONS.has(ext)) {
            onOpenFile(relPath)
            return
          }
        }
        void openPathMutation.mutateAsync({ absPath })
      }
    },
    [projectPath, onOpenFile]
  )

  return (
    <RichTextEditor
      value={content}
      onChange={onChange}
      onSave={onSave}
      editorRef={editorRef}
      variant="page"
      readability={readability}
      width={width}
      fontFamily={fontFamily}
      themeColors={themeColors}
      frontmatter
      htmlResolveSrc={resolveSrc}
      htmlOnLinkClick={handleLinkClick}
    />
  )
}
