/**
 * Imperative handles of one panel kind, per instance (docs/plans/panel-model.md
 * step 7): what `browserPanelRef` / `fileEditorRef` / `gitPanelRef` … were when a
 * kind had one panel. Kind components attach with `ref(instanceId)`; the page's
 * handlers reach the TARGET instance's handle (`get`), or queue work for one that
 * is not mounted yet (`whenReady`: the panel was just shown).
 */
export class InstanceHandles<T> {
  private readonly handles = new Map<string, T>()
  private readonly refs = new Map<string, (handle: T | null) => void>()
  private readonly pending = new Map<string, Array<(handle: T) => void>>()

  /** The ref callback for an instance's component (stable per instance id). */
  ref(instanceId: string): (handle: T | null) => void {
    let ref = this.refs.get(instanceId)
    if (!ref) {
      ref = (handle) => {
        if (!handle) {
          this.handles.delete(instanceId)
          return
        }
        this.handles.set(instanceId, handle)
        const queued = this.pending.get(instanceId)
        if (!queued) return
        this.pending.delete(instanceId)
        for (const run of queued) run(handle)
      }
      this.refs.set(instanceId, ref)
    }
    return ref
  }

  /** The instance's mounted handle, or null. */
  get(instanceId: string | null | undefined): T | null {
    return instanceId ? (this.handles.get(instanceId) ?? null) : null
  }

  /** Run `fn` with the instance's handle now, or as soon as it mounts. */
  whenReady(instanceId: string, fn: (handle: T) => void): void {
    const handle = this.handles.get(instanceId)
    if (handle) {
      fn(handle)
      return
    }
    this.pending.set(instanceId, [...(this.pending.get(instanceId) ?? []), fn])
  }

  /** Forget a closed instance (and work queued for it). */
  forget(instanceId: string): void {
    this.handles.delete(instanceId)
    this.refs.delete(instanceId)
    this.pending.delete(instanceId)
  }
}
