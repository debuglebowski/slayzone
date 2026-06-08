// cap-shell-dialog — REAL `window.api.dialog.showOpenDialog`.
//
// Routes to `slayzone::dialog::mojom::NativeDialogHost.ShowOpenDialog` on the
// browser side (chrome://slayzone-shell/ binding). cap-shell-dialog covers
// only the showOpenDialog surface — showSaveDialog + showMessageBox remain
// STUB until cap-shell-6 proper. The stubs return empty-shape results so
// callers don't throw.

import type { ElectronAPI } from '@slayzone/types'
import { nativeDialogRemote } from '../transport/mojo'

type DialogNS = ElectronAPI['dialog']
type ShowOpenOptions = Parameters<DialogNS['showOpenDialog']>[0]
type ShowOpenResult = Awaited<ReturnType<DialogNS['showOpenDialog']>>

async function showOpenDialog(options: ShowOpenOptions): Promise<ShowOpenResult> {
  const remote = await nativeDialogRemote()
  const { result } = await remote.showOpenDialog({
    properties: options?.properties ?? [],
    defaultPath: options?.defaultPath ?? '',
    title: options?.title ?? '',
  })
  return { canceled: result.canceled, filePaths: result.filePaths }
}

// STUB surfaces — shape-matched so renderer doesn't throw. cap-shell-6
// replaces with real Mojo plumbing once save + message dialogs are needed.
const showSaveDialog = async (): Promise<{ canceled: boolean; filePath?: string }> => ({
  canceled: true,
})
const showMessageBox = async (): Promise<{ response: number; checkboxChecked?: boolean }> => ({
  response: 0,
})

export const dialogShim = {
  showOpenDialog,
  showSaveDialog,
  showMessageBox,
} as unknown as DialogNS
