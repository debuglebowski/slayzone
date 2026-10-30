import type { ChatAttachment, QueuedChatMessage } from '@slayzone/terminal-contracts'
import { attachmentLabel, messageContent, queuedFiles, queuedLabel } from './attachments'

const png: ChatAttachment = {
  artifactId: 'a1',
  name: 'shot.png',
  kind: 'image',
  mediaType: 'image/png',
  size: 500
}
const txt: ChatAttachment = {
  artifactId: 'a2',
  name: 'notes.txt',
  kind: 'text',
  mediaType: 'text/plain',
  size: 2 * 1024 * 1024
}
const queued = (over: Partial<QueuedChatMessage>): QueuedChatMessage => ({
  id: 'q',
  tabId: 't',
  send: '',
  original: '',
  position: 0,
  createdAt: '',
  ...over
})

describe('chat attachments', () => {
  it('puts the files first, then the text, as desktop sends a message', () => {
    expect(messageContent('look', [png, txt])).toEqual([
      { type: 'attachment', attachment: png },
      { type: 'attachment', attachment: txt },
      { type: 'text', text: 'look' }
    ])
    expect(messageContent('', [png])).toEqual([{ type: 'attachment', attachment: png }])
    expect(messageContent('only text', [])).toEqual([{ type: 'text', text: 'only text' }])
  })

  it("names a file's kind and size in desktop's units", () => {
    expect(attachmentLabel(png)).toBe('Attached image shot.png, 500 B')
    expect(attachmentLabel(txt)).toBe('Attached text file notes.txt, 2.0 MB')
  })

  it('shows a queued message by its text, else by its files', () => {
    const files = [
      { type: 'attachment' as const, attachment: png },
      { type: 'attachment' as const, attachment: txt }
    ]
    expect(queuedLabel(queued({ original: 'hi', content: files }))).toBe('hi')
    expect(queuedLabel(queued({ content: files }))).toBe('shot.png, notes.txt')
    expect(queuedFiles(queued({ content: files }))).toEqual([png, txt])
    // Queued before files existed: no content.
    expect(queuedFiles(queued({ original: 'old' }))).toEqual([])
  })
})
