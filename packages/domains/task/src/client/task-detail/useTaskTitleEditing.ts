import React, { useState, useEffect, useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import type { Task } from '@slayzone/task/shared'

export interface UseTaskTitleEditingResult {
  editingTitle: boolean
  setEditingTitle: React.Dispatch<React.SetStateAction<boolean>>
  titleValue: string
  setTitleValue: React.Dispatch<React.SetStateAction<string>>
  titleInputRef: React.RefObject<HTMLInputElement | null>
  handleTitleSave: () => Promise<void>
  handleTitleKeyDown: (e: React.KeyboardEvent) => Promise<void>
}

/** Inline title editing: local edit buffer, focus-on-edit, external sync, save/keydown handlers. */
export function useTaskTitleEditing(
  task: Task | null,
  onTaskUpdated: (task: Task) => void
): UseTaskTitleEditingResult {
  const trpc = useTRPC()
  const updateTask = useMutation(trpc.task.update.mutationOptions())
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleValue, setTitleValue] = useState(task?.title ?? '')
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Sync title from global state when changed externally (not while editing)
  useEffect(() => {
    if (task && !editingTitle) setTitleValue(task.title)
  }, [task?.title, editingTitle])

  // Focus and select title input when editing
  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [editingTitle])

  const handleTitleSave = async (): Promise<void> => {
    if (!task || titleValue === task.title) {
      setEditingTitle(false)
      return
    }

    const updated = await updateTask.mutateAsync({
      id: task.id,
      title: titleValue
    })
    onTaskUpdated(updated)
    setEditingTitle(false)
  }

  const handleTitleKeyDown = async (e: React.KeyboardEvent): Promise<void> => {
    if (e.key === 'Enter') {
      await handleTitleSave()
    } else if (e.key === 'Escape') {
      setTitleValue(task?.title ?? '')
      setEditingTitle(false)
      titleInputRef.current?.blur()
    }
  }

  return {
    editingTitle,
    setEditingTitle,
    titleValue,
    setTitleValue,
    titleInputRef,
    handleTitleSave,
    handleTitleKeyDown
  }
}
