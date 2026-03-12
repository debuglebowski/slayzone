import { useCallback, useEffect, useRef, useState } from 'react'
import { useAction } from 'convex/react'
import { MessageSquare, Plus, Send, ArrowLeft, Trash2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  IconButton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
  toast
} from '@slayzone/ui'
import { api } from 'convex/_generated/api'

interface FeedbackThread {
  id: string
  title: string
  discord_thread_id: string | null
  created_at: string
}

interface FeedbackMessage {
  id: string
  thread_id: string
  content: string
  created_at: string
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso + 'Z').getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso + 'Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatDate(iso: string): string {
  return new Date(iso + 'Z').toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function FeedbackDialog(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [threads, setThreads] = useState<FeedbackThread[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<FeedbackMessage[]>([])
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)
  const [composingNew, setComposingNew] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const submit = useAction(api.feedback.submit)
  const markDeleted = useAction(api.feedback.markDeleted)

  const selectedThread = threads.find((t) => t.id === selectedId) ?? null

  const loadThreads = useCallback(async () => {
    const rows = await window.api.feedback.listThreads()
    setThreads(rows)
  }, [])

  const loadMessages = useCallback(async (threadId: string) => {
    const rows = await window.api.feedback.getMessages(threadId)
    setMessages(rows)
  }, [])

  useEffect(() => {
    if (open) {
      loadThreads()
      setSelectedId(null)
      setMessages([])
      setComposingNew(false)
      setContent('')
    }
  }, [open, loadThreads])

  useEffect(() => {
    if (selectedId) {
      loadMessages(selectedId)
      setComposingNew(false)
    }
  }, [selectedId, loadMessages])

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleNewThread = useCallback(() => {
    setSelectedId(null)
    setMessages([])
    setComposingNew(true)
    setContent('')
  }, [])

  const handleBack = useCallback(() => {
    setSelectedId(null)
    setMessages([])
    setComposingNew(false)
    setContent('')
  }, [])

  const handleDeleteThread = useCallback(async (thread: FeedbackThread) => {
    try {
      if (thread.discord_thread_id) {
        await markDeleted({ threadId: thread.discord_thread_id }).catch(() => {})
      }
      await window.api.feedback.deleteThread(thread.id)
      if (selectedId === thread.id) {
        setSelectedId(null)
        setMessages([])
      }
      await loadThreads()
      toast.success('Feedback deleted')
    } catch {
      toast.error('Failed to delete feedback')
    }
  }, [selectedId, markDeleted, loadThreads])

  const handleSend = useCallback(async () => {
    const text = content.trim()
    if (!text) return

    setSending(true)
    try {
      const version = await window.api.app.getVersion()

      if (composingNew || !selectedThread) {
        const threadId = crypto.randomUUID()
        const title = text.slice(0, 80).replace(/\n/g, ' ')

        const result = await submit({
          content: text,
          metadata: { appVersion: version }
        })

        await window.api.feedback.createThread({
          id: threadId,
          title,
          discord_thread_id: result.threadId ?? null
        })
        await window.api.feedback.addMessage({
          id: crypto.randomUUID(),
          thread_id: threadId,
          content: text
        })

        setComposingNew(false)
        await loadThreads()
        setSelectedId(threadId)
      } else {
        const result = await submit({
          content: text,
          threadId: selectedThread.discord_thread_id ?? undefined,
          metadata: { appVersion: version }
        })

        if (result.threadId && !selectedThread.discord_thread_id) {
          await window.api.feedback.updateThreadDiscordId(selectedThread.id, result.threadId)
        }

        await window.api.feedback.addMessage({
          id: crypto.randomUUID(),
          thread_id: selectedThread.id,
          content: text
        })

        await loadMessages(selectedThread.id)
        await loadThreads()
      }

      setContent('')
      toast.success('Feedback sent')
    } catch {
      toast.error('Failed to send feedback')
    } finally {
      setSending(false)
    }
  }, [content, composingNew, selectedThread, submit, loadThreads, loadMessages])

  const showCompose = composingNew || selectedThread

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <IconButton
            aria-label="Feedback"
            variant="ghost"
            size="icon-lg"
            onClick={() => setOpen(true)}
            className="rounded-lg text-muted-foreground"
          >
            <MessageSquare className="size-5" />
          </IconButton>
        </TooltipTrigger>
        <TooltipContent side="right">Feedback</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[70vh] max-h-[70vh] flex-col overflow-hidden p-0 sm:max-w-[720px]">
          <DialogHeader className="sr-only">
            <DialogTitle>Feedback</DialogTitle>
            <DialogDescription>Send feedback to the developers</DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1">
            {/* Thread list sidebar */}
            <div className="flex w-[240px] shrink-0 flex-col border-r bg-muted/20">
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <h2 className="text-sm font-semibold">Feedback</h2>
                <IconButton
                  aria-label="New feedback"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleNewThread}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Plus className="size-4" />
                </IconButton>
              </div>
              <div className="flex-1 overflow-y-auto scrollbar-thin">
                {threads.length === 0 && !composingNew && (
                  <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                    <MessageSquare className="size-6 text-muted-foreground/25" />
                    <p className="text-xs text-muted-foreground">No feedback yet</p>
                    <Button size="sm" variant="outline" onClick={handleNewThread} className="h-7 text-xs">
                      <Plus className="mr-1 size-3" />
                      New thread
                    </Button>
                  </div>
                )}
                {threads.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => setSelectedId(thread.id)}
                    className={cn(
                      'group relative w-full px-4 py-3 text-left transition-colors hover:bg-muted/50',
                      selectedId === thread.id
                        ? 'bg-muted border-l-2 border-l-primary'
                        : 'border-l-2 border-l-transparent'
                    )}
                  >
                    <p className="truncate pr-6 text-[13px] font-medium leading-snug">{thread.title}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground/60">{timeAgo(thread.created_at)}</p>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label="Delete thread"
                      className="absolute right-3 top-3 hidden rounded p-0.5 text-muted-foreground/50 hover:text-destructive group-hover:inline-flex"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteThread(thread)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.stopPropagation()
                          handleDeleteThread(thread)
                        }
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Message area */}
            <div className="flex min-w-0 flex-1 flex-col">
              {showCompose ? (
                <>
                  {/* Thread header */}
                  <div className="flex items-center gap-2.5 border-b px-4 py-3 bg-muted/10">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <IconButton
                          aria-label="Back"
                          variant="ghost"
                          size="icon-sm"
                          onClick={handleBack}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ArrowLeft className="size-3.5" />
                        </IconButton>
                      </TooltipTrigger>
                      <TooltipContent>Back</TooltipContent>
                    </Tooltip>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold leading-snug">
                        {composingNew ? 'New feedback' : selectedThread?.title}
                      </p>
                      {selectedThread && (
                        <p className="text-[11px] text-muted-foreground/60">{formatDate(selectedThread.created_at)}</p>
                      )}
                    </div>
                  </div>

                  {/* Messages */}
                  {messages.length > 0 && (
                    <div className="flex-1 overflow-y-auto scrollbar-thin">
                      <div className="px-5 py-4">
                        <div className="relative space-y-0">
                          {messages.map((msg) => (
                            <div key={msg.id} className="pb-3">
                              <div className="rounded-lg border bg-background p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
                                <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{msg.content}</p>
                                <p className="mt-2 text-[10px] text-muted-foreground/50">{formatDate(msg.created_at)}</p>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div ref={messagesEndRef} />
                      </div>
                    </div>
                  )}

                  {/* Empty state for new thread */}
                  {composingNew && (
                    <div className="flex flex-1 items-center justify-center">
                      <div className="text-center">
                        <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-primary/10">
                          <Send className="size-4 text-primary" />
                        </div>
                        <p className="text-sm font-medium">Start a conversation</p>
                        <p className="mt-1 text-xs text-muted-foreground">Your feedback goes directly to the team</p>
                      </div>
                    </div>
                  )}

                  {/* Compose */}
                  <div className="bg-muted/5 px-5 py-4">
                    <p className="mb-2 text-[10px] font-medium text-amber-500">Do not share any sensitive or personal information.</p>
                    <div className="rounded-lg border bg-background shadow-[0_1px_3px_rgba(0,0,0,0.04)] focus-within:ring-2 focus-within:ring-ring/50">
                      <textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder={composingNew ? "What's on your mind?" : 'Reply…'}
                        rows={2}
                        autoFocus
                        className="w-full resize-none border-0 bg-transparent px-3 pt-3 pb-1 text-[13px] placeholder:text-muted-foreground/50 focus:outline-none"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault()
                            handleSend()
                          }
                        }}
                      />
                      <div className="flex items-center justify-between px-3 pb-2">
                        <span className="text-[10px] text-muted-foreground/40">
                          {navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}+Enter
                        </span>
                        <Button
                          size="sm"
                          disabled={!content.trim() || sending}
                          onClick={handleSend}
                          className="h-7 gap-1.5 px-3 text-xs"
                        >
                          <Send className="size-3" />
                          {sending ? 'Sending…' : 'Send'}
                        </Button>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center">
                  <div className="text-center">
                    <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-muted/50">
                      <MessageSquare className="size-6 text-muted-foreground/40" />
                    </div>
                    <p className="text-sm font-medium">Send us feedback</p>
                    <p className="mx-auto mt-1.5 max-w-[240px] text-xs leading-relaxed text-muted-foreground">
                      Share ideas, report bugs, or let us know how we can improve
                    </p>
                    <Button size="sm" onClick={handleNewThread} className="mt-4 h-8 gap-1.5 px-4 text-xs">
                      <Plus className="size-3.5" />
                      New feedback
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
