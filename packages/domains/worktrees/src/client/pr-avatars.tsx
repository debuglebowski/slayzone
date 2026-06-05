import { useState } from 'react'
import { cn } from '@slayzone/ui'

const avatarColors = [
  'bg-blue-500/20 text-blue-400',
  'bg-purple-500/20 text-purple-400',
  'bg-green-500/20 text-green-400',
  'bg-orange-500/20 text-orange-400',
  'bg-pink-500/20 text-pink-400',
  'bg-cyan-500/20 text-cyan-400',
  'bg-yellow-500/20 text-yellow-400',
  'bg-red-500/20 text-red-400'
]

function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return avatarColors[Math.abs(hash) % avatarColors.length]
}

const failedAvatars = new Set<string>()

export function AuthorAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const [imgError, setImgError] = useState(() => failedAvatars.has(name))
  const initials = name.slice(0, 2).toUpperCase()
  const sizeClass = size === 'sm' ? 'h-4 w-4' : 'h-6 w-6'

  if (!imgError) {
    return (
      <img
        src={`https://github.com/${name}.png?size=48`}
        alt={name}
        className={cn(sizeClass, 'rounded-full')}
        onError={() => {
          failedAvatars.add(name)
          setImgError(true)
        }}
      />
    )
  }

  return (
    <div
      className={cn(
        'rounded-full flex items-center justify-center font-bold select-none',
        sizeClass,
        size === 'sm' ? 'text-[7px]' : 'text-[9px]',
        avatarColor(name)
      )}
    >
      {initials}
    </div>
  )
}
