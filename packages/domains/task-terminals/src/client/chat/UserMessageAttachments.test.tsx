// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChatAttachment } from '@slayzone/terminal-contracts'

const paths: Record<string, string> = {
  a: '/home/me/.slayzone/artifacts/t/a.png',
  b: '/home/me/.slayzone/artifacts/t/b.pdf'
}
vi.mock('@slayzone/editor/hooks', () => ({
  useArtifactUpload: () => ({
    uploadFiles: vi.fn(),
    getFilePath: async (id: string) => paths[id] ?? null
  })
}))

import { UserMessageAttachments } from './UserMessageAttachments'
import { ChatViewContext } from './ChatViewContext'

afterEach(cleanup)

const IMG: ChatAttachment = {
  artifactId: 'a',
  name: 'red.png',
  kind: 'image',
  mediaType: 'image/png',
  size: 2048
}
const PDF: ChatAttachment = {
  artifactId: 'b',
  name: 'spec.pdf',
  kind: 'pdf',
  mediaType: 'application/pdf',
  size: 3 * 1024 * 1024
}

function renderWith(attachments: ChatAttachment[] | undefined, onOpenFile = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ChatViewContext.Provider value={{ onOpenFile } as never}>
        <UserMessageAttachments attachments={attachments} />
      </ChatViewContext.Provider>
    </QueryClientProvider>
  )
  return onOpenFile
}

describe('UserMessageAttachments', () => {
  it('nothing for a message without files', () => {
    renderWith(undefined)
    expect(screen.queryByTestId('chat-message-attachments')).toBeNull()
  })

  it('an image shows its thumbnail; a document its name and size', async () => {
    renderWith([IMG, PDF])
    const img = (await screen.findByRole('img', { name: 'red.png' })) as HTMLImageElement
    expect(img.src).toContain('slz-file://')
    expect(screen.getByText('spec.pdf')).toBeDefined()
    expect(screen.getByText('3.0 MB')).toBeDefined()
  })

  it('clicking a file opens it', async () => {
    const onOpenFile = renderWith([PDF])
    fireEvent.click(screen.getByRole('button', { name: /spec\.pdf/ }))
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(paths.b))
  })
})
