import { useDialogStore } from '@slayzone/dialogs'

/**
 * Open the app's Create Project dialog on a hub (null = the default hub). The app
 * shell owns the dialog and what follows a create (the board shows and selects the
 * project); this is the way in for a surface that does not, like a hub's Settings
 * page.
 */
export function openCreateProject(hubId: string | null = null): void {
  useDialogStore.getState().openCreateProject(hubId)
}
