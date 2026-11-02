/**
 * The artifacts panel's sidebar (tree / search list), saved per task like the
 * file editor's tree (`EditorOpenFilesState.treeVisible/treeWidth`). Missing
 * fields = the panel's defaults (visible, default width).
 */
export interface ArtifactsSidebarState {
  visible?: boolean
  width?: number
}
