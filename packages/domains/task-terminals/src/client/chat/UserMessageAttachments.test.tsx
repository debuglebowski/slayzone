// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render as renderRTL, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { TooltipProvider } from '@slayzone/ui'
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

import { UserMessageAttachments, UserMessageContent } from './UserMessageAttachments'
import { ChatViewContext, defaultChatView } from './ChatViewContext'
import { AttachmentChip } from './attachments/AttachmentChip'

function render(ui: ReactElement) {
  return renderRTL(<TooltipProvider>{ui}</TooltipProvider>)
}

beforeEach(() => {
  // Radix Popper measures its trigger; jsdom does not implement ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

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

  it('images and documents show compact clickable names and sizes, without inline previews', () => {
    renderWith([IMG, PDF])
    expect(screen.getByRole('button', { name: 'Open red.png' })).toBeDefined()
    expect(screen.getByText('red.png')).toBeDefined()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('spec.pdf')).toBeDefined()
    expect(screen.getByText('3.0 MB')).toBeDefined()
  })

  it('clicking a file opens it', async () => {
    const onOpenFile = renderWith([PDF])
    fireEvent.click(screen.getByRole('button', { name: /spec\.pdf/ }))
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(paths.b))
  })
})

describe('draft attachment preview', () => {
  it('opens an uploaded image before sending; removal does not open it', async () => {
    const onOpenFile = vi.fn()
    const onRemove = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatViewContext.Provider value={{ onOpenFile } as never}>
          <AttachmentChip attachment={IMG} onRemove={onRemove} />
        </ChatViewContext.Provider>
      </QueryClientProvider>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open red.png' }))
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(paths.a))
    onOpenFile.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Remove red.png' }))
    expect(onRemove).toHaveBeenCalledOnce()
    expect(onOpenFile).not.toHaveBeenCalled()
  })
})

describe('path-based image messages', () => {
  it('shows legacy images as compact file chips and opens the original path', () => {
    const onOpenFile = vi.fn()
    const path = '/Users/me/.slayzone/artifacts/Screenshot (1).png'
    render(
      <ChatViewContext.Provider value={{ ...defaultChatView, onOpenFile }}>
        <UserMessageContent text={`![Screenshot (1).png](${path})\n\nWhy is this shown?`} />
      </ChatViewContext.Provider>
    )
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Screenshot (1).png')).toBeDefined()
    expect(screen.getByText('Why is this shown?')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Open Screenshot (1).png' }))
    expect(onOpenFile).toHaveBeenCalledWith(path)
  })

  it('preserves regular text and does not load remote images', () => {
    const text = 'Plain **text**\n![remote](https://example.com/image.png)'
    render(<UserMessageContent text={text} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText(/Plain/).textContent).toBe(text)
  })
})

it('draft and sent attachment clicks open the artifacts panel by id', () => {
  const onOpenArtifact = vi.fn()
  const onOpenFile = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ChatViewContext.Provider value={{ ...defaultChatView, onOpenArtifact, onOpenFile }}>
        <AttachmentChip attachment={IMG} onRemove={vi.fn()} />
        <UserMessageAttachments attachments={[IMG]} />
      </ChatViewContext.Provider>
    </QueryClientProvider>
  )
  for (const button of screen.getAllByRole('button', { name: 'Open red.png' }))
    fireEvent.click(button)
  expect(onOpenArtifact).toHaveBeenCalledTimes(2)
  expect(onOpenArtifact).toHaveBeenCalledWith(IMG.artifactId)
  expect(onOpenFile).not.toHaveBeenCalled()
})

it('places clickable attachments below the text card; image-only messages have no empty card', () => {
  const onOpenArtifact = vi.fn()
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ChatViewContext.Provider value={{ ...defaultChatView, onOpenArtifact }}>
        <UserMessageContent text="Describe this" attachments={[IMG]} />
      </ChatViewContext.Provider>
    </QueryClientProvider>
  )
  const attachment = screen.getByRole('button', { name: 'Open red.png' })
  const card = screen.getByTestId('chat-user-message-card')
  expect(card.contains(attachment)).toBe(false)
  expect(card.compareDocumentPosition(attachment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(attachment)
  expect(onOpenArtifact).toHaveBeenCalledWith('a')
  view.unmount()
  render(<UserMessageContent text="![shot.png](/tmp/shot.png)" />)
  expect(screen.queryByTestId('chat-user-message-card')).toBeNull()
})

it('shows an image preview on hover without putting images inside the message card', async () => {
  const onOpenFile = renderWith([IMG])
  const button = screen.getByRole('button', { name: 'Open red.png' })
  expect(screen.queryByRole('img')).toBeNull()
  fireEvent.pointerMove(button, { pointerType: 'mouse' })
  const tooltip = await screen.findByRole('tooltip')
  const image = await within(tooltip).findByAltText('red.png')
  expect(image.getAttribute('src')).toContain('slz-file://app/')
  expect(within(tooltip).queryByText('red.png')).toBeNull()
  fireEvent.click(button)
  await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledWith(paths.a))
})

it('previews legacy image references on keyboard focus; missing images show a fallback', async () => {
  const path = '/tmp/legacy.png'
  render(
    <ChatViewContext.Provider value={{ ...defaultChatView, onOpenFile: vi.fn() }}>
      <UserMessageContent text={`![legacy.png](${path})\n\nDescribe this`} />
    </ChatViewContext.Provider>
  )
  const button = screen.getByRole('button', { name: 'Open legacy.png' })
  fireEvent.focus(button)
  const tooltip = await screen.findByRole('tooltip')
  const image = within(tooltip).getByAltText('legacy.png')
  expect(image.getAttribute('src')).toContain(path)
  fireEvent.error(image)
  expect(within(tooltip).getByText('Preview unavailable')).toBeDefined()
})
