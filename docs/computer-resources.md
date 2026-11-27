# Computer resource limits

Remote computers (standalone `slayzone-computer` installs) manage agent memory by
default. The desktop app's own local computer does not: it starts agents as
before, keeps no live-agent cap or warm-pool limit, and never hibernates chats,
unless its `computer.config.json` sets `agentResources` (any value, even `{}`,
opts in). Its health report is still measured and shown.

A computer that manages memory queues background and warm agent starts while
memory is under pressure or the live-agent cap is full. A foreground start (one
the user asked for: opening a tab, sending a message) is never held back by
pressure or the cap. It starts at once and counts toward the live agents, and a
warm agent gives up its slot for it. Warm agents count toward the cap and give up
their slots when real work needs room.

An idle chat with a confirmed provider session can hibernate under pressure or
when the live agents exceed the cap or the queue needs a slot. Hibernation closes the agent, keeps its transcript,
and resumes the same provider session when the tab is opened or a message is sent.
Tasks pinned in SlayZone and chats with active turns, unanswered prompts, or
background jobs stay running during idle reclamation.

Defaults apply without a config file. To override them on one computer, or to
opt the desktop app's local computer in, add `agentResources` to its
`computer.config.json` and restart that computer. The local computer's file is
`~/.slayzone/<channel>/computer/computer.config.json`.

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
- `minAvailableMemoryPercent` sets the available-memory threshold. Linux reads
  `MemAvailable` and also uses memory PSI to detect thrashing. macOS reads
  `kern.memorystatus_level` (the free percentage `memory_pressure` reports, which
  counts reclaimable cache) and its warn/critical pressure level. A sample that
  cannot be read is skipped and the last reading stays.
- `idleBeforeHibernateMs` controls how long a chat must be idle.
- `warmPoolSize` bounds spare agents across the computer. Set it to `0` to disable prewarming.
- `startConcurrency` accepts a positive integer. Omit it for the default of 2–4 parallel
  starts, based on CPU cores.
- `pinnedTaskIds` adds machine-local exceptions to idle reclamation.

SlayZone's Linux systemd units delegate cgroup v2 memory control to the computer.
Agents share a soft memory limit (`memory.high`) of 80% of available RAM capacity:
past it the kernel reclaims their memory, into swap where the host has it, and slows
them down, but never kills them for it. Each agent and its subprocesses get their
own cgroup so stopping an agent reaches every process it started. If an agent's
cgroup cannot be created or joined, the agent starts without it and the computer
logs why. Linux hosts without delegation still use admission, idle reclamation, and
agent OOM score adjustment. Settings (a hub's Computers tab) shows the current health report or
the last report received before disconnect.

On existing Linux installs, `slay computer restart <name> --upgrade` refreshes the
systemd units as well as the computer binary. Restart when the computer is idle.
