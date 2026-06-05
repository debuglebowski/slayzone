import { useState, useEffect, useRef, type ComponentProps } from 'react'
import { Input } from '@slayzone/ui'

/** Input that holds local state while typing and commits on blur. */
export function DebouncedInput({
  value: propValue,
  onValueCommit,
  ...props
}: Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  value: string
  onValueCommit: (value: string) => void
}) {
  const [localValue, setLocalValue] = useState(propValue)
  const committedRef = useRef(propValue)

  useEffect(() => {
    // Sync from props only when external value changes (not from our own commit)
    if (propValue !== committedRef.current) {
      committedRef.current = propValue
      setLocalValue(propValue)
    }
  }, [propValue])

  return (
    <Input
      {...props}
      value={localValue}
      onChange={(e) => setLocalValue(e.target.value)}
      onBlur={() => {
        if (localValue !== committedRef.current) {
          committedRef.current = localValue
          onValueCommit(localValue)
        }
      }}
    />
  )
}
