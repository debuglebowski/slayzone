import { useQuery } from '@tanstack/react-query'
import { useArtifactUpload } from '@slayzone/editor/hooks'
import { toSlzFileUrl } from '@slayzone/platform/slz-file-url'
import type { ChatAttachment } from '@slayzone/terminal-contracts'

/** Resolve an artifact path once. Hover content mounts this only while open. */
export function useAttachmentPreview(attachment: ChatAttachment) {
  const { getFilePath } = useArtifactUpload(null)
  const { data: path, isPending } = useQuery({
    queryKey: ['chat-attachment-path', attachment.artifactId],
    queryFn: () => getFilePath(attachment.artifactId),
    staleTime: Infinity
  })
  return {
    path: path ?? null,
    src: attachment.kind === 'image' && path ? toSlzFileUrl(path, attachment.contentHash) : null,
    loading: isPending
  }
}
