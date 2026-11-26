import type { ReactNode } from 'react'

// Tree guide layout (mirrors EditorToc / ManagerSidebar).
export const TG_INDENT = 22
export const TG_ROW_HEIGHT = 32
export const TG_CURVE_R = 5
export const TG_ELBOW_END_OFFSET = 7
export const TG_ROOT_X = 15
export const TG_TEXT_GAP_AFTER_CURVE = 2
export const tgGuideX = (ancestorDepth: number) => TG_ROOT_X + TG_INDENT * ancestorDepth
export const tgPaddingLeft = (depth: number) =>
  depth === 0 ? TG_ROOT_X : tgGuideX(depth - 1) + TG_ELBOW_END_OFFSET + TG_TEXT_GAP_AFTER_CURVE

export function TreeGuides({
  depth,
  ancestorFlags,
  height = TG_ROW_HEIGHT
}: {
  depth: number
  ancestorFlags: boolean[]
  /** Row height (the dense look's rows are shorter). */
  height?: number
}): ReactNode {
  if (depth <= 0) return null
  const parentX = tgGuideX(depth - 1)
  const mid = height / 2
  const r = TG_CURVE_R
  const endX = parentX + TG_ELBOW_END_OFFSET
  const continueBelow = ancestorFlags[depth - 1] ?? false
  const connector =
    `M ${parentX} 0 V ${mid - r} Q ${parentX} ${mid} ${parentX + r} ${mid} H ${endX}` +
    (continueBelow ? ` M ${parentX} ${mid - r} V ${height}` : '')
  const svgWidth = endX + 2
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute top-0 left-0 text-border"
      width={svgWidth}
      height={height}
    >
      {ancestorFlags
        .slice(0, -1)
        .map((flag, a) =>
          flag ? (
            <line
              key={a}
              x1={tgGuideX(a)}
              x2={tgGuideX(a)}
              y1={0}
              y2={height}
              stroke="currentColor"
              strokeWidth={1}
            />
          ) : null
        )}
      <path d={connector} fill="none" stroke="currentColor" strokeWidth={1} />
    </svg>
  )
}
