import { useRef } from 'react'

// Lazy-mount: first trigger loads the chunk + mounts; stays mounted after so close/reopen animations work.
export function useLazyMounted(): (key: string, open: boolean) => boolean {
  const set = useRef(new Set<string>())
  return (key: string, open: boolean) => {
    if (open) set.current.add(key)
    return set.current.has(key)
  }
}
