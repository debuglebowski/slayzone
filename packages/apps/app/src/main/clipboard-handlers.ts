import { clipboard, ClipboardItem } from 'electron'
import { type ClipboardPort, createFilePathClipboard } from './clipboard-file-paths'

const electronClipboard: ClipboardPort = {
  read: async () => {
    const items = await clipboard.read()
    return items.map((item) => ({
      types: item.types,
      getType: async (type: string) => {
        const value = await item.getType(type)
        // Only `electron application/bookmark` resolves to a non-Blob, and we never ask for it.
        if (!(value instanceof Blob)) throw new Error(`clipboard type ${type} is not a Blob`)
        return value
      }
    }))
  },
  write: (entry) => clipboard.write([new ClipboardItem(entry)]),
  clear: () => clipboard.clear()
}

const fileClipboard = createFilePathClipboard(electronClipboard)
export const { writeFilePaths, readFilePaths, hasFilePaths } = fileClipboard
