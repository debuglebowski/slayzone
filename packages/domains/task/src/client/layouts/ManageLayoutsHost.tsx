import { useEffect } from 'react'
import { LayoutEditorDialog } from './LayoutEditorDialog'
import { ManageLayoutsDialog } from './ManageLayoutsDialog'
import { layoutDialogs, useLayoutDialogs } from './manageLayoutsStore'

/**
 * The window's Manage layouts dialog and layout editor (docs/plans/panel-model.md
 * step 11). The app shell mounts it lazily on the first `OPEN_MANAGE_LAYOUTS_EVENT`
 * and bumps `openRequest` on every one: each opens Manage layouts.
 */
export function ManageLayoutsHost({ openRequest }: { openRequest: number }): React.JSX.Element {
  const { manageOpen, editor } = useLayoutDialogs()
  useEffect(() => {
    if (openRequest > 0) layoutDialogs.showManage()
  }, [openRequest])
  return (
    <>
      <ManageLayoutsDialog
        open={manageOpen}
        onOpenChange={(open) => (open ? layoutDialogs.showManage() : layoutDialogs.closeManage())}
      />
      <LayoutEditorDialog target={editor} onClose={layoutDialogs.closeEditor} />
    </>
  )
}
