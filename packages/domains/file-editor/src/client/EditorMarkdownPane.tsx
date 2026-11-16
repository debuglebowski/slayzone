import { useCallback, useEffect, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from './trpc'
import { getThemeEditorColors } from '@slayzone/ui'
import {
  RichTextEditor,
  getEditorViewDOM,
  type Editor as MilkdownEditor,
  type LinkOpenTarget
} from '@slayzone/editor'
import { parseSlzFileUrl, toSlzFileUrl, SLZ_FILE_PREFIX } from '@slayzone/platform/slz-file-url'
import { relativeToRoot, useWorkspaceFileUrl } from './workspace-file-url'
import { MARKDOWN_FILE_TEXT_EXTENSIONS, posixDirname, posixResolve } from './FileEditorView.utils'

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
  /** ⌘/Ctrl-clicked markdown links. */
  onOpenLink: (href: string, target: LinkOpenTarget) => void
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
  onOpenLink,
  themeColors,
  readability,
  width,
  fontFamily,
  handleRef
}: MarkdownFilePaneProps) {
  const trpc = useTRPC()
  // mutateAsync is identity-stable across renders (the mutation objects are not).
  const { mutateAsync: openExternal } = useMutation(trpc.app.shell.openExternal.mutationOptions())
  const { mutateAsync: openPath } = useMutation(trpc.app.shell.openPath.mutationOptions())
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

  const workspaceFileUrl = useWorkspaceFileUrl(projectPath)
  // Images inside the workspace load from wherever it lives (a remote computer
  // included); anything outside it can only be a path on this machine.
  const resolveSrc = useCallback(
    (src: string): string => {
      const abs = src.startsWith('/') ? src : posixResolve(fileDirAbs, src)
      const rel = relativeToRoot(projectPath, abs)
      return rel ? workspaceFileUrl(rel) : toSlzFileUrl(abs)
    },
    [fileDirAbs, projectPath, workspaceFileUrl]
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
        void openExternal({ url: resolvedHref })
        return
      }
      if (resolvedHref.startsWith(SLZ_FILE_PREFIX)) {
        const parsed = parseSlzFileUrl(resolvedHref.replace(/#.*$/, ''))
        if (!parsed) return
        const absPath =
          parsed.kind === 'local'
            ? parsed.path
            : parsed.source.kind === 'workspace'
              ? `${parsed.source.rootPath.replace(/\/+$/, '')}/${parsed.relPath}`
              : null
        if (!absPath) return
        const relPath = relativeToRoot(projectPath, absPath)
        if (relPath) {
          const ext = relPath.split('.').pop()?.toLowerCase() ?? ''
          if (MARKDOWN_FILE_TEXT_EXTENSIONS.has(ext)) {
            onOpenFile(relPath)
            return
          }
        }
        void openPath({ absPath })
      }
    },
    [projectPath, onOpenFile, openExternal, openPath]
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
      onOpenLink={onOpenLink}
    />
  )
}
