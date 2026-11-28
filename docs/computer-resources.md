# Computer resource limits

Remote computers (standalone `slayzone-computer` installs) manage agent memory by
default. The desktop app's own local computer does not: it starts agents as
before, keeps no live-agent cap or warm-pool limit, and never hibernates chats for
memory, unless its `computer.config.json` sets `agentResources` (any value, even
`{}`, opts in). Its health report is still measured and shown. Idle-close (below)
is the user's setting, not memory management, so it applies on every computer.

A computer that manages memory queues background and warm agent starts while
memory is under pressure or the live-agent cap is full. A foreground start (one
the user asked for: opening a tab, sending a message) is never held back by
pressure or the cap. It starts at once and counts toward the live agents, and a
warm agent gives up its slot for it. Warm agents count toward the cap and give up
their slots when real work needs room.

An idle chat with a confirmed provider session hibernates in two cases:

- **Idle-close.** The hub's *Auto-close idle agents* setting (Settings, agents) is
  on and the chat has been idle longer than its *Idle timeout*: the same setting
  that closes idle terminal agents. The computer asks its hub for the window
  (`chat.idlePolicy`) on a 10-second sweep, so a changed setting applies within
  seconds and is never configured on the computer. Before each hibernation the hub
  checks again that the setting is still on, that the chat is past the current
  window, and that nobody used the task's browser panel within it.
- **Memory reclamation** (computers that manage memory). Memory is under pressure,
  the live agents exceed the cap, or the queue needs a slot. The longest-idle chat
  that has been idle at least `idleBeforeHibernateMs` goes first, one at a time
  until the pressure clears. This works whether idle-close is on or off.

Hibernation closes the agent, keeps its transcript, and resumes the same provider
session when the tab is opened or a message is sent. Sending a message, or the
agent producing output, restarts the idle clock. Tasks pinned in SlayZone, the
computer's `pinnedTaskIds`, and chats with active turns, unanswered prompts,
background jobs or sub-agents stay running in both cases. `"hibernate": false`
turns both off on that computer.

A hub older than idle-close for chats answers no window, and its chats hibernate
for memory only, as before. An older computer never asks, and keeps hibernating
for memory only. Idle-close for chats needs both the hub and the computer updated.

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
- `hibernate: false` stops this computer from hibernating chats at all, for memory
  or for idle-close. Admission still respects memory and the live-agent cap when
  hibernation is disabled.
- `minAvailableMemoryPercent` sets the available-memory threshold. Linux reads
  `MemAvailable` and also uses memory PSI to detect thrashing. macOS reads
  `kern.memorystatus_level` (the free percentage `memory_pressure` reports, which
  counts reclaimable cache) and its warn/critical pressure level. A sample that
  cannot be read is skipped and the last reading stays.
- `idleBeforeHibernateMs` controls how long a chat must be idle before memory
  reclamation may hibernate it (default 5 minutes). It does not change the
  idle-close window, which is only ever the hub's *Idle timeout*. With both in play
  a chat hibernates at whichever comes first: the idle-close window, or under
  pressure after `idleBeforeHibernateMs`.
- `warmPoolSize` bounds spare agents across the computer. Set it to `0` to disable prewarming.
- `startConcurrency` accepts a positive integer. Omit it for the default of 2–4 parallel
  starts, based on CPU cores.
- `pinnedTaskIds` adds machine-local exceptions to both memory reclamation and
  idle-close.

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
