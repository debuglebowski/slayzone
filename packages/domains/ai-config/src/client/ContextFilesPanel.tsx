import { useState, type ChangeEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'
import { File, FilePlus, Save } from 'lucide-react'
import { Button, Label, Textarea, cn } from '@slayzone/ui'

interface ContextFilesPanelProps {
  projectPath: string | null
}

export function ContextFilesPanel({ projectPath }: ContextFilesPanelProps) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()

  const { data: files = [] } = useQuery(
    trpc.aiConfig.discoverContextFiles.queryOptions({ projectPath: projectPath ?? '' }),
  )

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  const writeFile = useMutation(
    trpc.aiConfig.writeContextFile.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: trpc.aiConfig.discoverContextFiles.queryKey({ projectPath: projectPath ?? '' }),
        })
      },
    }),
  )

  const openFile = async (filePath: string) => {
    setLoading(true)
    setMessage('')
    try {
      const text = await trpcClient.aiConfig.readContextFile.query({ filePath, projectPath: projectPath ?? '' })
      setContent(text)
      setOriginalContent(text)
      setSelectedPath(filePath)
    } catch {
      setMessage('Could not read file')
    } finally {
      setLoading(false)
    }
  }

  const createFile = async (filePath: string) => {
    setMessage('')
    try {
      await writeFile.mutateAsync({ filePath, content: '', projectPath: projectPath ?? '' })
      setContent('')
      setOriginalContent('')
      setSelectedPath(filePath)
      setMessage('File created')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to create file')
    }
  }

  const saveFile = async () => {
    if (!selectedPath) return
    setMessage('')
    try {
      await writeFile.mutateAsync({ filePath: selectedPath, content, projectPath: projectPath ?? '' })
      setOriginalContent(content)
      setMessage('Saved')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Failed to save')
    }
  }

  const dirty = content !== originalContent
  const selectedFile = files.find((f) => f.path === selectedPath)

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {files.map((file) => (
          <button
            key={file.path}
            onClick={() => file.exists ? openFile(file.path) : createFile(file.path)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors',
              selectedPath === file.path
                ? 'border-primary bg-primary/10'
                : file.exists
                  ? 'hover:bg-muted/50'
                  : 'border-dashed text-muted-foreground hover:bg-muted/30'
            )}
          >
            {file.exists ? (
              <File className="size-3.5 shrink-0" />
            ) : (
              <FilePlus className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 truncate font-mono text-xs">{file.name}</span>
            {!file.exists && (
              <span className="ml-auto text-[11px] text-muted-foreground">Create</span>
            )}
          </button>
        ))}
      </div>

      {selectedPath && (
        <div className="space-y-2 rounded-lg border bg-surface-3 p-4">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs font-mono">{selectedFile?.name ?? selectedPath}</Label>
            <div className="flex items-center gap-2">
              {message && <span className="text-[11px] text-muted-foreground">{message}</span>}
              <Button size="sm" onClick={saveFile} disabled={!dirty || writeFile.isPending}>
                <Save className="mr-1 size-3" />
                {writeFile.isPending ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (
            <Textarea
              className="min-h-64 font-mono text-sm"
              placeholder="File content..."
              value={content}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setContent(e.target.value)}
            />
          )}
        </div>
      )}
    </div>
  )
}
