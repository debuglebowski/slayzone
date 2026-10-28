import type { Task } from '@slayzone/task-contracts'
import type { DetectedWorktree } from '../shared/types'

export interface WorktreeNode extends DetectedWorktree {
  children: WorktreeNode[]
  task?: Task
  depth: number
}
