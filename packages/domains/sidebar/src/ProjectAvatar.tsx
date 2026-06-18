import { cn } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'
import { toSlzFileUrl } from '@slayzone/platform/slz-file-url'

/**
 * Presentational project avatar — the colored square with custom letters (or
 * the first 2 letters of the name) or an uploaded icon image. Sized via
 * `className`. Reused at full size by ProjectItem and as 2×2 minis inside a
 * Discord-style folder tile.
 */
export function ProjectAvatar({
  project,
  className,
  lettersClassName
}: {
  project: Project
  className?: string
  lettersClassName?: string
}) {
  const customLetters = project.icon_letters?.trim().toUpperCase()
  const fallbackLetters = project.name.slice(0, 2).toUpperCase()
  const letters = customLetters && customLetters.length > 0 ? customLetters : fallbackLetters
  const autoLettersClass =
    letters.length >= 5 ? 'text-[8px]' : letters.length > 2 ? 'text-[9px]' : 'text-xs'
  const iconSrc = project.icon_image_path
    ? toSlzFileUrl(project.icon_image_path, project.updated_at)
    : null
  return (
    <div
      className={cn(
        'flex items-center justify-center overflow-hidden font-semibold text-white',
        !iconSrc && (lettersClassName ?? autoLettersClass),
        className
      )}
      style={{ backgroundColor: project.color }}
    >
      {iconSrc ? (
        <img src={iconSrc} alt="" className="w-full h-full object-cover" draggable={false} />
      ) : (
        letters
      )}
    </div>
  )
}
