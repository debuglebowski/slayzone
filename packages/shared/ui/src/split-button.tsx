import { useState } from 'react'
import type { VariantProps } from 'class-variance-authority'
import { ChevronDown } from 'lucide-react'

import { Button, buttonVariants } from './button'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { cn } from './utils'

interface SplitButtonProps {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  className?: string
  variant?: VariantProps<typeof buttonVariants>['variant']
  size?: VariantProps<typeof buttonVariants>['size']
  menu: (close: () => void) => React.ReactNode
  menuAlign?: 'start' | 'end'
}

function SplitButton({
  children,
  onClick,
  disabled,
  className,
  variant = 'outline',
  size = 'sm',
  menu,
  menuAlign = 'end'
}: SplitButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)

  return (
    <div className="flex gap-1">
      <Button
        variant={variant}
        size={size}
        onClick={onClick}
        disabled={disabled}
        className={className}
      >
        {children}
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant={variant} size={size} disabled={disabled} className="px-1.5">
            <ChevronDown className="h-3 w-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align={menuAlign} className="w-56 p-1">
          {menu(close)}
        </PopoverContent>
      </Popover>
    </div>
  )
}

function SplitButtonItem({
  children,
  onClick,
  className
}: {
  children: React.ReactNode
  onClick: () => void
  className?: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted transition-colors text-left',
        className
      )}
    >
      {children}
    </button>
  )
}

export { SplitButton, SplitButtonItem }
