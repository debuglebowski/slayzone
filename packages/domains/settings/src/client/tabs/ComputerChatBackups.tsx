import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Switch,
  Label,
  Input,
  toast,
  safeRandomUUID,
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction
} from '@slayzone/ui'
import {
  userMessageAttachments,
  type ArchivedArtifactVersion,
  type ChatAttachment,
  type AgentEvent
} from '@slayzone/terminal-contracts'
import { useTRPC, useTRPCClient } from '../trpc'

function download(data: Blob, name: string) {
  const url = URL.createObjectURL(data),
    link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function ComputerChatBackups() {
  const trpc = useTRPC()
  const computers = useQuery(trpc.computers.list.queryOptions())
  const [selected, setSelected] = useState<string | null>(null)
  const computerId = selected ?? computers.data?.[0]?.id
  return (
    <Card>
      <CardHeader>
        <CardTitle>Computer chat backups</CardTitle>
        <CardDescription>
          Each computer backs up its conversations and attached files. Restore opens a read-only
          archive; agent sessions cannot be resumed from it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {computers.error && <p role="alert">{computers.error.message}</p>}
        <Select value={computerId ?? ''} onValueChange={setSelected}>
          <SelectTrigger aria-label="Chat backup computer">
            <SelectValue placeholder="Select computer" />
          </SelectTrigger>
          <SelectContent>
            {computers.data?.map((pc) => (
              <SelectItem key={pc.id} value={pc.id}>
                {pc.name}
                {pc.usable ? '' : ' · offline'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {computerId && (
          <ComputerBackupList
            key={computerId}
            computerId={computerId}
            usable={computers.data?.find((c) => c.id === computerId)?.usable ?? false}
          />
        )}
      </CardContent>
    </Card>
  )
}
function ComputerBackupList({ computerId, usable }: { computerId: string; usable: boolean }) {
  const trpc = useTRPC(),
    client = useQueryClient(),
    target = { computerId }
  const backups = useQuery(
    trpc.chat.backups.list.queryOptions(target, { enabled: usable, retry: false })
  )
  const archives = useQuery(
    trpc.chat.archives.list.queryOptions(target, { enabled: usable, retry: false })
  )
  const settings = useQuery(
    trpc.chat.backups.settings.queryOptions(target, { enabled: usable, retry: false })
  )
  const create = useMutation(trpc.chat.backups.create.mutationOptions()),
    restore = useMutation(trpc.chat.backups.restore.mutationOptions()),
    remove = useMutation(trpc.chat.backups.delete.mutationOptions()),
    configure = useMutation(trpc.chat.backups.configure.mutationOptions())
  const [archiveId, setArchiveId] = useState<string | null>(null),
    [deleteId, setDeleteId] = useState<string | null>(null)
  const reload = () => {
    void client.invalidateQueries(trpc.chat.backups.list.queryFilter(target))
    void client.invalidateQueries(trpc.chat.archives.list.queryFilter(target))
  }
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action()
      reload()
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }
  if (!usable)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Computer offline. Reconnect it to access its backups and archives.
      </p>
    )
  const error = backups.error ?? archives.error ?? settings.error
  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error.message}
        </p>
      )}
      <Button
        variant="outline"
        disabled={create.isPending}
        onClick={() => void run(() => create.mutateAsync({ ...target, id: safeRandomUUID() }))}
      >
        {create.isPending ? 'Creating backup…' : 'Back up chats now'}
      </Button>
      {settings.data && (
        <div className="space-y-3 rounded border p-3">
          <Label className="flex items-center gap-3">
            <Switch
              checked={settings.data.autoEnabled}
              disabled={configure.isPending}
              onCheckedChange={(autoEnabled) =>
                void run(async () => {
                  await configure.mutateAsync({
                    ...target,
                    settings: { ...settings.data!, autoEnabled }
                  })
                  await client.invalidateQueries(trpc.chat.backups.settings.queryFilter(target))
                })
              }
            />
            Automatic chat backups
          </Label>
          <div className="flex flex-wrap gap-4">
            <Label>
              Every (minutes)
              <Input
                type="number"
                min={15}
                className="mt-1 w-28"
                key={`interval-${settings.data.intervalMinutes}`}
                defaultValue={settings.data.intervalMinutes}
                onBlur={(e) => {
                  const intervalMinutes = Number(e.currentTarget.value)
                  if (Number.isInteger(intervalMinutes) && intervalMinutes >= 15)
                    void run(async () => {
                      await configure.mutateAsync({
                        ...target,
                        settings: { ...settings.data!, intervalMinutes }
                      })
                      await client.invalidateQueries(trpc.chat.backups.settings.queryFilter(target))
                    })
                }}
              />
            </Label>
            <Label>
              Keep automatic backups (0 = all)
              <Input
                type="number"
                min={0}
                className="mt-1 w-28"
                key={`keep-${settings.data.maxAutoBackups}`}
                defaultValue={settings.data.maxAutoBackups}
                onBlur={(e) => {
                  const maxAutoBackups = Number(e.currentTarget.value)
                  if (Number.isInteger(maxAutoBackups) && maxAutoBackups >= 0)
                    void run(async () => {
                      await configure.mutateAsync({
                        ...target,
                        settings: { ...settings.data!, maxAutoBackups }
                      })
                      await client.invalidateQueries(trpc.chat.backups.settings.queryFilter(target))
                    })
                }}
              />
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Manual backups stay until you delete them.
          </p>
        </div>
      )}
      {backups.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">No chat backups on this computer.</p>
      )}
      {backups.data?.map((backup) => (
        <div
          key={backup.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded border p-3 text-sm"
        >
          <div>
            {new Date(backup.createdAt).toLocaleString()} · {backup.kind}
            <p className="text-xs text-muted-foreground">
              {backup.conversations} conversations · {(backup.sizeBytes / 1048576).toFixed(1)} MB
            </p>
            {backup.error && (
              <p role="alert" className="text-destructive">
                {backup.error}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!!backup.error || restore.isPending}
              onClick={() =>
                void run(async () => {
                  const archive = await restore.mutateAsync({
                    ...target,
                    backupId: backup.id,
                    archiveId: safeRandomUUID()
                  })
                  setArchiveId(archive.id)
                })
              }
            >
              {restore.isPending ? 'Restoring…' : 'Open restored archive'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDeleteId(backup.id)}>
              Delete
            </Button>
          </div>
        </div>
      ))}
      {!!archives.data?.length && (
        <Label className="block space-y-2">
          <span>Read-only archives</span>
          <Select value={archiveId ?? ''} onValueChange={setArchiveId}>
            <SelectTrigger>
              <SelectValue placeholder="Select archive" />
            </SelectTrigger>
            <SelectContent>
              {archives.data.map((a) => (
                <SelectItem key={a.id} value={a.id} disabled={!!a.error}>
                  {a.error ?? new Date(a.createdAt).toLocaleString()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
      )}
      {archiveId && <ArchiveReader key={archiveId} computerId={computerId} archiveId={archiveId} />}
      <AlertDialog
        open={!!deleteId}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat backup?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes this backup. Restored archives remain available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const id = deleteId
                setDeleteId(null)
                if (id) void run(() => remove.mutateAsync({ ...target, id }))
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
function ArchiveReader({ computerId, archiveId }: { computerId: string; archiveId: string }) {
  const trpc = useTRPC(),
    target = { computerId, archiveId }
  const conversations = useQuery(
    trpc.chat.archives.conversations.queryOptions(target, { retry: false })
  )
  const [selected, setSelected] = useState<string | null>(null)
  const conversationId = selected ?? conversations.data?.[0]?.id
  return (
    <div className="space-y-3 rounded border p-3">
      <p className="text-sm font-medium">Read-only history</p>
      <p className="text-xs text-muted-foreground">
        Viewing saved content. Live conversations remain separate.
      </p>
      {conversations.error && <p role="alert">{conversations.error.message}</p>}
      <Select value={conversationId ?? ''} onValueChange={setSelected}>
        <SelectTrigger aria-label="Archived conversation">
          <SelectValue placeholder="Select conversation" />
        </SelectTrigger>
        <SelectContent>
          {conversations.data?.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.title ?? c.taskId} · {c.mode} · {c.tabId} ({c.events} events)
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {conversationId && (
        <ArchiveConversation key={conversationId} {...target} conversationId={conversationId} />
      )}
    </div>
  )
}
function ArchiveConversation(target: {
  computerId: string
  archiveId: string
  conversationId: string
}) {
  const api = useTRPCClient(),
    [events, setEvents] = useState<Array<{ seq: number; at: number; event: AgentEvent }>>([]),
    [records, setRecords] = useState<
      Array<{ cursor: number; kind: string; id: string; value: unknown }>
    >([])
  const [nextSeq, setNextSeq] = useState(-1),
    [nextCursor, setNextCursor] = useState(0),
    [more, setMore] = useState(true),
    [moreRecords, setMoreRecords] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const load = async () => {
    setBusy(true)
    setError('')
    try {
      if (more) {
        const page = await api.chat.archives.read.query({ ...target, afterSeq: nextSeq })
        setEvents((e) => [...e, ...page.events])
        setNextSeq(page.nextSeq)
        setMore(page.hasMore)
      }
      if (moreRecords) {
        const page = await api.chat.archives.records.query({ ...target, afterCursor: nextCursor })
        setRecords((r) => [...r, ...page.records])
        setNextCursor(page.nextCursor)
        setMoreRecords(page.hasMore)
      }
    } catch (e) {
      setError(errorMessage(e))
    }
    setBusy(false)
  }
  const saveAttachment = async (ref: ChatAttachment) => {
    try {
      const { data } = await api.chat.archives.attachment.query({ ...target, ref })
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
      download(new Blob([bytes], { type: ref.mediaType }), ref.name)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const saveFile = async (version: ArchivedArtifactVersion) => {
    try {
      const file = await api.chat.archives.file.query({
        ...target,
        artifactId: version.artifactId,
        contentHash: version.contentHash
      })
      download(new Blob([Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0))]), file.name)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const exportHistory = async () => {
    setBusy(true)
    await exportArchivedConversation(api, target).catch((e: unknown) => setError(errorMessage(e)))
    setBusy(false)
  }
  return (
    <div className="space-y-3">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void exportHistory()}>
        Export history and files
      </Button>
      {events.map(({ seq, at, event }) => (
        <div key={seq} className="rounded border p-2 text-sm">
          <div className="text-xs text-muted-foreground">
            {event.kind} · {new Date(at).toLocaleString()}
          </div>
          {'text' in event && typeof event.text === 'string' ? (
            <p className="whitespace-pre-wrap break-words">{event.text}</p>
          ) : (
            <pre className="whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(event, null, 2)}
            </pre>
          )}
          {event.kind === 'user-message' &&
            userMessageAttachments(event.content ?? []).map((ref) => (
              <Button
                key={`${ref.artifactId}:${ref.contentHash}`}
                size="sm"
                variant="link"
                onClick={() => void saveAttachment(ref)}
              >
                {ref.name}
              </Button>
            ))}
        </div>
      ))}
      {records.map((record) =>
        record.kind === 'artifact-version' ? (
          <ArchivedFileVersion
            key={record.cursor}
            version={record.value as ArchivedArtifactVersion}
            onDownload={saveFile}
          />
        ) : (
          <details key={record.cursor}>
            <summary className="text-sm">Saved {record.kind}</summary>
            <pre className="whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(record.value, null, 2)}
            </pre>
          </details>
        )
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {(more || moreRecords) && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
          {busy ? 'Loading…' : events.length || records.length ? 'Load more' : 'Load saved history'}
        </Button>
      )}
    </div>
  )
}

function ArchivedFileVersion({
  version,
  onDownload
}: {
  version: ArchivedArtifactVersion
  onDownload: (version: ArchivedArtifactVersion) => Promise<void>
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border p-2 text-sm">
      <div>
        <p>{version.name}</p>
        <p className="text-xs text-muted-foreground">
          Version {version.versionNum}
          {version.versionName ? ` · ${version.versionName}` : ''} · {version.size} bytes
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={() => void onDownload(version)}>
        Download
      </Button>
    </div>
  )
}

async function exportArchivedConversation(
  api: ReturnType<typeof useTRPCClient>,
  target: { computerId: string; archiveId: string; conversationId: string }
) {
  const allEvents: Array<{ seq: number; at: number; event: AgentEvent }> = [],
    allRecords: Array<{ cursor: number; kind: string; id: string; value: unknown }> = []
  let afterSeq = -1,
    afterCursor = 0
  while (true) {
    const page = await api.chat.archives.read.query({ ...target, afterSeq })
    allEvents.push(...page.events)
    if (!page.hasMore) break
    afterSeq = page.nextSeq
  }
  while (true) {
    const page = await api.chat.archives.records.query({ ...target, afterCursor })
    allRecords.push(...page.records)
    if (!page.hasMore) break
    afterCursor = page.nextCursor
  }
  const refs = new Map<string, ChatAttachment>()
  for (const { event } of allEvents)
    if (event.kind === 'user-message')
      for (const ref of userMessageAttachments(event.content ?? []))
        refs.set(`${ref.artifactId}:${ref.contentHash ?? ''}`, ref)
  for (const record of allRecords)
    if (record.kind === 'draft') {
      const draft = record.value as { draft?: { attachments?: ChatAttachment[] } }
      for (const ref of draft.draft?.attachments ?? [])
        refs.set(`${ref.artifactId}:${ref.contentHash ?? ''}`, ref)
    }
  const attachments = []
  for (const ref of refs.values())
    attachments.push({ ref, ...(await api.chat.archives.attachment.query({ ...target, ref })) })
  const files = []
  for (const record of allRecords) {
    if (record.kind !== 'artifact-version') continue
    const version = record.value as ArchivedArtifactVersion
    files.push({
      version,
      ...(await api.chat.archives.file.query({
        ...target,
        artifactId: version.artifactId,
        contentHash: version.contentHash
      }))
    })
  }
  download(
    new Blob(
      [
        JSON.stringify(
          {
            format: 'slayzone-chat-archive',
            version: 1,
            readOnly: true,
            providerResumable: false,
            ...target,
            events: allEvents,
            records: allRecords,
            attachments,
            files
          },
          null,
          2
        )
      ],
      { type: 'application/json' }
    ),
    `chat-${target.conversationId}.json`
  )
}
