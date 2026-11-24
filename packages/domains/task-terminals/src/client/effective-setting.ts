/**
 * The value of a hub setting for one task's work: the task's project's own value,
 * else the hub's (`settings.effective`, plans/settings-by-scope.md). A hub older than
 * project overrides has no such procedure — it reads the hub's value as before.
 */
export async function readSettingForTask(
  client: {
    settings: {
      effective: {
        query: (input: { key: string; taskId: string }) => Promise<{ value: string | null }>
      }
      get: { query: (input: { key: string }) => Promise<string | null> }
    }
  },
  key: string,
  taskId: string
): Promise<string | null> {
  return client.settings.effective
    .query({ key, taskId })
    .then((r) => r.value)
    .catch(() => client.settings.get.query({ key }))
}
