# Demo mode

"Try demo" on the sign-in screen opens the whole app on sample data, with no hub, no
account and no network. It exists for App Review (Guideline 2.1: a reviewer must be able
to use the app) and for anyone who wants to look before setting up a hub.

## How it works

The demo is a **hub served inside the app**, not a second set of screens. Every screen
is the app's own and runs unchanged:

| Path | Real hub | Demo hub |
| --- | --- | --- |
| tRPC (`useTRPC`, `HubScope`) | socket per hub (`FederationProvider`) | `inProcessLink` over the demo's handlers (`FederationProvider` `inProcessLinks`): no socket, always connected |
| REST (`/api/*`: artifact search, file download, upload; account email) | `fetch` / the OS downloader | `HubSession.inProcess.http` (`../in-process-hub.ts`) |
| Session | keychain (`hub-session.ts`) | `HubSessionsProvider` state only (`enterDemo` / `exitDemo`) |

- `demo-hub.ts`: the hub. Handlers are typed by the app router (`typed.ts`), so a
  renamed or reshaped procedure fails the typecheck here, not the demo at runtime.
  Answers are copies (as a wire would hand them over) and writes push the same events a
  hub pushes (`notify.onTasksChanged`, `pty.onStateChange`, `chat.onEvent`, …).
- `seed.ts`: three projects, tasks in every column, subtasks, tags, a blocker, four
  agents (Codex terminal running, Claude chat finished + unread, Claude chat idle,
  Claude Code asleep 💤), artifacts (markdown with mermaid diagrams, a PNG, a folder).
  Times are relative to the moment the demo opens.
- `transcripts.ts`: the chat agents' conversations (`AgentEvent`s, the shapes the
  recorded hub fixture `../chat/__fixtures__/hub-chat-session.json` has).
- `terminal-recording.ts`: the terminal agent's output (ANSI chunks).
- `demo-image.ts`: the PNG (a SlayZone desktop screenshot), base64 in the JS bundle.
- `DemoBanner.tsx`: "DEMO · Sample data — changes reset when you exit · Exit demo",
  above every tab (`TabStack`).

## Writes: in memory, reset on exit

Writes work, like on a hub, and are kept in memory only: creating / editing / moving /
archiving / deleting tasks and subtasks, tags, blockers, uploading artifacts, sending a
chat message (the demo answers itself: no agent runs), typing into the terminal (echoed,
with a note), start / stop / interrupt / restart / reset of agents. Exit demo (the
banner, or Settings → Hubs → Exit demo) drops the demo hub; the next "Try demo" starts from the
sample data again. Signing in to a real hub from inside the demo (Hubs → Add a hub) also
ends it.

What needs a real computer answers `DEMO_UNAVAILABLE` ("Not available in the demo — sign
in to your own hub for this."): browsing and creating folders, choosing another
computer, artifact versions, queued chat messages, plan decisions.

## What the demo never touches

- The keychain: no session is saved or forgotten (`demo.test.tsx` asserts it).
- The network: the demo hub's address is `demo.invalid` (RFC 2606, never resolves) and
  none of its calls leave the process.
- The kept theme (`theme-cache.ts`): the demo's is never saved, so it never paints the
  next launch's first frame.
- Hubs signed in before: they are untouched and come back when the demo closes.

## Tests

- `demo.test.tsx`: end to end through the real routes, hub connections and transport —
  every tab, a task with subtasks and artifacts, a mermaid page, a chat send + reply,
  terminal echo, a write gone after exit + re-enter, keychain untouched.
- `demo-hub.test.ts`: the hub alone (board, copies, pushes, isolation between demos,
  chat reply + dispose, REST: account, search, image download, upload).
- `../hub-sessions.test.tsx`: enter / exit / sign-out / sign-in-from-demo.
- `@slayzone/transport` `inProcessHub.test.tsx`: the federation seam.

## App Review note

App Store Connect → TestFlight → Test Information (and App Review Information for the
App Store) carries:

> SlayZone is the mobile client for a self-hosted SlayZone hub. To review without a hub,
> tap "Try demo" on the sign-in screen: it opens the full app on sample data (no account,
> no network). Every tab works — Agents, Tasks, Search, Hubs — including task details,
> artifacts, an agent chat and a terminal. Changes stay on the device and reset when you
> tap "Exit demo".
