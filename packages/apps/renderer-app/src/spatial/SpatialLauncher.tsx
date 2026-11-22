import { useState, type FormEvent } from 'react'
import type { SpatialBridge } from './spatial-bridge'
import type { SpatialGroup } from './spatial-route'

interface ProjectGroups {
  projectId: string
  group: SpatialGroup
}

const storageKey = 'slayzone:spatial-groups'

function getGroups(): ProjectGroups[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.filter(
      (entry): entry is ProjectGroups =>
        typeof entry?.projectId === 'string' &&
        typeof entry.group?.id === 'string' &&
        typeof entry.group.name === 'string'
    )
  } catch {
    return []
  }
}

export function SpatialLauncher({
  projects,
  bridge
}: {
  projects: readonly { id: string; name: string }[]
  bridge: SpatialBridge
}): React.JSX.Element {
  const [groups, setGroups] = useState(getGroups)
  const [creatingFor, setCreatingFor] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState(false)

  function openBoard(projectId: string, title: string, group: SpatialGroup): void {
    bridge.open({ panel: 'board', projectId, group }, title)
  }

  function createGroup(event: FormEvent, project: { id: string; name: string }): void {
    event.preventDefault()
    const groupName = name.trim()
    if (!groupName) return
    const group = { id: crypto.getRandomValues(new Uint32Array(4)).join('-'), name: groupName }
    const next = [...getGroups(), { projectId: project.id, group }]
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      setError(true)
      return
    }
    setGroups(next)
    setCreatingFor(null)
    setName('')
    setError(false)
    openBoard(project.id, project.name, group)
  }

  return (
    <div className="flex h-svh flex-col gap-4 overflow-auto bg-background p-6 text-foreground">
      <h1 className="text-2xl font-semibold">Projects</h1>
      {projects.length === 0 && <p className="text-muted-foreground">No projects yet.</p>}
      <ul className="flex flex-col gap-4">
        {projects.map((project) => (
          <li key={project.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                className="min-h-11 rounded-lg px-2 text-left text-lg font-medium hover:bg-accent"
                onClick={() =>
                  openBoard(project.id, project.name, { id: project.id, name: project.name })
                }
              >
                {project.name}
              </button>
              <button
                type="button"
                className="min-h-11 rounded-lg border border-border px-3 text-sm hover:bg-accent"
                aria-label={`New group for ${project.name}`}
                onClick={() => {
                  setCreatingFor(project.id)
                  setName('')
                  setError(false)
                }}
              >
                New group
              </button>
            </div>
            {groups
              .filter((entry) => entry.projectId === project.id)
              .map(({ group }) => (
                <button
                  key={group.id}
                  type="button"
                  className="mt-2 mr-2 min-h-11 rounded-lg border border-border px-3 text-sm hover:bg-accent"
                  onClick={() => openBoard(project.id, project.name, group)}
                >
                  {group.name}
                </button>
              ))}
            {creatingFor === project.id && (
              <form
                className="mt-3 flex flex-wrap items-end gap-2"
                onSubmit={(event) => createGroup(event, project)}
              >
                <label className="flex min-w-0 grow flex-col gap-1 text-sm">
                  Group name
                  <input
                    className="min-h-11 rounded-lg border border-input bg-background px-3"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    maxLength={48}
                  />
                </label>
                <button
                  type="submit"
                  className="min-h-11 rounded-lg bg-primary px-3 text-sm text-primary-foreground"
                >
                  Create
                </button>
                <button
                  type="button"
                  className="min-h-11 rounded-lg px-3 text-sm hover:bg-accent"
                  onClick={() => setCreatingFor(null)}
                >
                  Cancel
                </button>
                {error && (
                  <p role="alert" className="w-full text-sm text-destructive">
                    Could not save this window group.
                  </p>
                )}
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
