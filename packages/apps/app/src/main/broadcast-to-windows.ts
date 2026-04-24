import { BrowserWindow } from 'electron'

export function broadcastToWindows(channel: string, ...args: unknown[]): void {
  BrowserWindow.getAllWindows().forEach((win) => win.webContents.send(channel, ...args))
}
