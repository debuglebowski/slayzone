# Computer resource limits

Computers queue agent starts while memory is under pressure or the live-agent cap
is full. Starts for the visible tab get priority. Warm agents count toward the cap
and give up their slots when real work needs room.

An idle chat with a confirmed provider session can hibernate under pressure or
when the queue needs a slot. Hibernation closes the agent, keeps its transcript,
and resumes the same provider session when the tab is opened or a message is sent.
Tasks pinned in SlayZone and chats with active turns, unanswered prompts, or
background jobs stay running during idle reclamation.

Defaults apply without a config file. To override them on one computer, add
`agentResources` to its `computer.config.json` and restart that computer.

```json
{
  "agentResources": {
    "maxLiveAgents": "auto",
    "hibernate": true,
    "minAvailableMemoryPercent": 15,
    "idleBeforeHibernateMs": 300000,
    "warmPoolSize": 1,
    "pinnedTaskIds": []
  }
}
```

- `maxLiveAgents` accepts a positive integer or `"auto"`. Auto divides the RAM budget
  by the measured agent footprint, with a 512 MiB minimum estimate.
- `hibernate` controls idle chat reclamation. Admission still respects memory and the
  live-agent cap when hibernation is disabled.
- `minAvailableMemoryPercent` sets the available-memory threshold. Linux also uses
  memory PSI to detect thrashing.
- `idleBeforeHibernateMs` controls how long a chat must be idle.
- `warmPoolSize` bounds spare agents across the computer. Set it to `0` to disable prewarming.
- `startConcurrency` accepts a positive integer. Omit it for the default of 2–4 parallel
  starts, based on CPU cores.
- `pinnedTaskIds` adds machine-local exceptions to idle reclamation.

SlayZone's Linux systemd units delegate cgroup v2 memory control to the computer.
Agents share a hard memory limit of 80% of available RAM capacity. Each agent and
its subprocesses form an OOM group, so a kernel kill stays in the agent workload.
Linux hosts without delegation still use admission, idle reclamation, and agent
OOM score adjustment. Settings → Connections shows the current health report or
the last report received before disconnect.

On existing Linux installs, `slay computer restart <name> --upgrade` refreshes the
systemd units as well as the computer binary. Restart when the computer is idle.
