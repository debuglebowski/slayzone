import * as React from 'react'
import { Button, type buttonVariants } from './button'
import type { VariantProps } from 'class-variance-authority'

type IconButtonProps = Omit<React.ComponentProps<'button'>, 'aria-label'> &
  VariantProps<typeof buttonVariants> & {
    /** Required accessible label describing the button's action */
    'aria-label': string
  }

/**
 * Icon-only button with enforced `aria-label` for accessibility.
 * Defaults to `variant="ghost"` and `size="icon"`.
 */
function IconButton({
  variant = 'ghost',
  size = 'icon',
  ...props
}: IconButtonProps): React.JSX.Element {
  return <Button variant={variant} size={size} {...props} />
}

export { IconButton, type IconButtonProps }
