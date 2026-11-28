/**
 * Idle-close for chats on computers: the hub's half. The computer finds chats that
 * are idle past the window the hub announces (`chat.idlePolicy`), then asks
 * `chat.hibernateCheck` with `reason: 'idle'` — and the hub re-decides here, so a
 * setting turned off, a window lengthened, or a user engaged since the computer
 * last asked never hibernates a chat.
 */
import { describe, expect, test } from "vitest";
import {
  chatIdleCloseAllows,
  idleCloseWindowMs,
  readIdleCloseConfig,
} from "./chat-idle-close.js";

describe("readIdleCloseConfig — the user setting, shared by ptys and chats", () => {
  const read = (values: Record<string, string | undefined>) =>
    readIdleCloseConfig((key) => values[key]);

  test('strictly opt-in: only "1" enables it', () => {
    expect(read({}).enabled).toBe(false);
    expect(read({ terminal_auto_close_idle: "0" }).enabled).toBe(false);
    expect(read({ terminal_auto_close_idle: "true" }).enabled).toBe(false);
    expect(read({ terminal_auto_close_idle: "1" }).enabled).toBe(true);
  });

  test("value and unit, defaulting to 30 minutes", () => {
    expect(read({}).idleMs).toBe(30 * 60_000);
    expect(
      read({
        terminal_idle_close_value: "15",
        terminal_idle_close_unit: "seconds",
      }).idleMs,
    ).toBe(15_000);
    expect(
      read({
        terminal_idle_close_value: "2",
        terminal_idle_close_unit: "hours",
      }).idleMs,
    ).toBe(7_200_000);
    expect(read({ terminal_idle_close_value: "junk" }).idleMs).toBe(
      30 * 60_000,
    );
  });
});

describe("idleCloseWindowMs — what chat.idlePolicy announces", () => {
  test("off → null", () => {
    expect(idleCloseWindowMs({ enabled: false, idleMs: 60_000 })).toBeNull();
  });
  test("on → the window, floored at 5s like the pty sweep", () => {
    expect(idleCloseWindowMs({ enabled: true, idleMs: 60_000 })).toBe(60_000);
    expect(idleCloseWindowMs({ enabled: true, idleMs: 1_000 })).toBe(5_000);
  });
});

describe("chatIdleCloseAllows — the hub re-check at hibernation time", () => {
  const on = { enabled: true, idleMs: 60_000 };
  const now = 1_000_000;

  test("memory reclamation is not an idle-close decision: always passes", () => {
    expect(
      chatIdleCloseAllows(
        { reason: "pressure" },
        { enabled: false, idleMs: 60_000 },
        undefined,
        now,
      ),
    ).toBe(true);
  });

  test("idle: refused once the setting is off", () => {
    expect(
      chatIdleCloseAllows(
        { reason: "idle", idleForMs: 3_600_000 },
        { enabled: false, idleMs: 60_000 },
        undefined,
        now,
      ),
    ).toBe(false);
  });

  test("idle: refused while the chat is still inside the (possibly lengthened) window", () => {
    expect(
      chatIdleCloseAllows(
        { reason: "idle", idleForMs: 59_000 },
        on,
        undefined,
        now,
      ),
    ).toBe(false);
    expect(chatIdleCloseAllows({ reason: "idle" }, on, undefined, now)).toBe(
      false,
    );
    expect(
      chatIdleCloseAllows(
        { reason: "idle", idleForMs: 60_000 },
        on,
        undefined,
        now,
      ),
    ).toBe(true);
  });

  test("idle: refused while the user engaged with the task inside the window", () => {
    expect(
      chatIdleCloseAllows(
        { reason: "idle", idleForMs: 3_600_000 },
        on,
        now - 10_000,
        now,
      ),
    ).toBe(false);
    expect(
      chatIdleCloseAllows(
        { reason: "idle", idleForMs: 3_600_000 },
        on,
        now - 60_000,
        now,
      ),
    ).toBe(true);
  });
});
