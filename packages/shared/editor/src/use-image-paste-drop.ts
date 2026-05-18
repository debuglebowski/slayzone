import { useCallback, useRef, useState } from 'react'

export function extractImageFilesFromDataTransfer(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return []
  const out: File[] = []
  if (dt.items && dt.items.length > 0) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f && f.type.startsWith('image/')) out.push(f)
      }
    }
  }
  if (out.length === 0 && dt.files && dt.files.length > 0) {
    for (const f of Array.from(dt.files)) {
      if (f.type.startsWith('image/')) out.push(f)
    }
  }
  return out
}

export interface UseImagePasteDropOpts<T> {
  onUpload: (files: File[]) => Promise<T[]>
  onInsert: (results: T[]) => void
  onError?: (err: unknown) => void
}

export interface UseImagePasteDropReturn {
  extractImageFiles: (dt: DataTransfer | null | undefined) => File[]
  handleFiles: (files: File[]) => Promise<boolean>
  isUploading: boolean
  isDragging: boolean
  onDragEnter: () => void
  onDragLeave: () => void
  resetDrag: () => void
}

export function useImagePasteDrop<T>(opts: UseImagePasteDropOpts<T>): UseImagePasteDropReturn {
  const { onUpload, onInsert, onError } = opts
  const [isUploading, setIsUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragDepth = useRef(0)

  const extractImageFiles = useCallback(
    (dt: DataTransfer | null | undefined) => extractImageFilesFromDataTransfer(dt),
    []
  )

  const handleFiles = useCallback(async (files: File[]): Promise<boolean> => {
    if (files.length === 0) return false
    setIsUploading(true)
    try {
      const results = await onUpload(files)
      onInsert(results)
      return true
    } catch (err) {
      onError?.(err)
      return false
    } finally {
      setIsUploading(false)
    }
  }, [onUpload, onInsert, onError])

  const onDragEnter = useCallback(() => {
    dragDepth.current += 1
    if (dragDepth.current === 1) setIsDragging(true)
  }, [])

  const onDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDragging(false)
  }, [])

  const resetDrag = useCallback(() => {
    dragDepth.current = 0
    setIsDragging(false)
  }, [])

  return { extractImageFiles, handleFiles, isUploading, isDragging, onDragEnter, onDragLeave, resetDrag }
}
