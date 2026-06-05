// --- Pixel geometry constants + row/column → pixel mapping ---
// Shared by the layout algorithm, SVG renderers, the row renderer, and the
// CommitGraph component. Kept React-free so any of them can import without
// pulling in rendering deps.

export const ROW_HEIGHT = 44
export const COLUMN_WIDTH = 24
export const DOT_RADIUS = 4
export const MERGE_DOT_OUTER = 6
export const MERGE_DOT_INNER = 3
export const GUTTER_PAD = 12

/** Hit-area size for dot tooltip overlays */
export const DOT_HIT_SIZE = 18

/** Extra x-shift applied to the main dot on merged (syntheticBranch) rows */
export const MERGED_DOT_OFFSET = 0

export function colX(col: number): number {
  return col * COLUMN_WIDTH + COLUMN_WIDTH / 2 + GUTTER_PAD / 2
}

export function rowY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2
}
