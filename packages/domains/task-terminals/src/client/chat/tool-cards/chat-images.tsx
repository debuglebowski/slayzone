/**
 * Images of saved tool results, as the user sees them. Saved history carries a
 * REFERENCE for each stored image (`chat-blobs`); its bytes are read from the chat's
 * computer when the image is shown — paged (`chat.readBlob`), checked against their
 * sha256, cached by hash (the bytes never change). Inline images (older rows, live
 * output) show at once, as before.
 *
 * @module task-terminals/chat/tool-cards/chat-images
 */
import { createContext, useContext, useEffect, useState } from 'react'
import {
  bytesToBase64,
  readChatBlob,
  type ChatBlobChunkReader,
  type ChatBlobRefBody
} from '@slayzone/terminal-contracts'
import { cn } from '@slayzone/ui'
import type { ChatImageSource } from './image-source'

/** One chunk of a blob the chat tab's conversation pins (`chat.readBlob`). */
export type ChatBlobReader = ChatBlobChunkReader

/** Provided by ChatPanel for its tab. Absent (previews, harnesses): stored images are unavailable. */
export const ChatBlobReaderContext = createContext<ChatBlobReader | null>(null)

/** Loaded images kept (data URLs), most recently used last. */
const CACHE_MAX = 64
const cache = new Map<string, Promise<string>>()

/** Tests: forget loaded images. */
export function clearChatImageCache(): void {
  cache.clear()
}

/** Every chunk of `ref`, joined and verified (`readChatBlob`), as a data URL. */
async function load(read: ChatBlobReader, ref: ChatBlobRefBody): Promise<string> {
  return `data:${ref.mediaType};base64,${bytesToBase64(await readChatBlob(read, ref))}`
}

function cachedLoad(read: ChatBlobReader, ref: ChatBlobRefBody): Promise<string> {
  const key = `${ref.sha256}:${ref.mediaType}`
  let found = cache.get(key)
  if (found) cache.delete(key)
  else
    found = load(read, ref).catch((error: unknown) => {
      // A failed load is retried the next time the image is shown.
      if (cache.get(key) === found) cache.delete(key)
      throw error
    })
  cache.set(key, found)
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
  return found
}

export type ChatImageState =
  | { status: 'none'; src: null }
  | { status: 'loading'; src: null }
  | { status: 'ready'; src: string }
  | { status: 'error'; src: null }

/** The image `source` shows: inline at once, a stored one once its bytes are loaded. */
export function useChatImage(source: ChatImageSource | null): ChatImageState {
  const read = useContext(ChatBlobReaderContext)
  const sha = source?.ref?.sha256 ?? null
  const mediaType = source?.ref?.mediaType ?? ''
  const size = source?.ref?.size ?? 0
  const [loaded, setLoaded] = useState<{ key: string; src: string | null } | null>(null)
  useEffect(() => {
    if (!sha || !read) return
    let live = true
    const key = `${sha}:${mediaType}`
    cachedLoad(read, { v: 1, sha256: sha, mediaType, size }).then(
      (src) => {
        if (live) setLoaded({ key, src })
      },
      () => {
        if (live) setLoaded({ key, src: null })
      }
    )
    return () => {
      live = false
    }
  }, [read, sha, mediaType, size])
  if (!source) return { status: 'none', src: null }
  if (source.src !== undefined) return { status: 'ready', src: source.src }
  if (!read) return { status: 'error', src: null }
  if (loaded?.key !== `${sha}:${mediaType}`) return { status: 'loading', src: null }
  return loaded.src === null ? { status: 'error', src: null } : { status: 'ready', src: loaded.src }
}

/** Where a stored image stands while it is not ready: loading, or unavailable. */
export function ChatImagePending({
  image,
  alt,
  className
}: {
  image: ChatImageState
  alt: string
  className?: string
}) {
  if (image.status === 'loading')
    return (
      <div
        data-testid="chat-image-loading"
        role="status"
        aria-label={`Loading ${alt}`}
        className={cn(
          'h-24 w-40 animate-pulse rounded border border-border/50 bg-muted/40',
          className
        )}
      />
    )
  if (image.status === 'error')
    return <div className="text-xs italic text-muted-foreground">Image unavailable</div>
  return null
}

/** An image of a tool result (inline or stored), with its loading / unavailable states. */
export function ChatImage({
  source,
  alt,
  className
}: {
  source: ChatImageSource
  alt: string
  className?: string
}) {
  const image = useChatImage(source)
  if (image.status === 'ready') return <img src={image.src} alt={alt} className={className} />
  return <ChatImagePending image={image} alt={alt} />
}
