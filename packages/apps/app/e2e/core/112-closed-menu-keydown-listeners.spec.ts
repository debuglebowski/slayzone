import type { Page } from "@playwright/test";
import {
  test,
  expect,
  seed,
  goHome,
  clickProject,
  openTaskById,
  showProjectBoard,
  resetApp,
  TEST_PROJECT_PATH,
} from "../fixtures/electron";

// A keystroke must not pay for menus that are closed. Every mounted Radix menu root
// (ContextMenu / DropdownMenu) used to register its own `document` keydown capture
// listener to track keyboard-vs-pointer use — one per kanban card, several per
// (hidden) task tab: ~520 on a 52-tab session, all run on every key, typing into a
// terminal included. The patched `@radix-ui/react-menu` shares ONE tracker across all
// roots, so the listener count is independent of how many menus are mounted.
//
// Counted, not timed: listener counts are deterministic; the per-keystroke times are
// logged as secondary evidence only.

type TabStoreWindow = Window & {
  __slayzone_tabStore: {
    getState: () => {
      tabs: Array<{ type: string }>;
      openTaskInBackground: (taskId: string) => void;
    };
  };
};

/** keydown listeners registered on `document` + `window` (exact, via CDP). */
async function keydownListeners(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  try {
    let n = 0;
    for (const expression of ["document", "window"]) {
      const { result } = await cdp.send("Runtime.evaluate", { expression });
      const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
        objectId: result.objectId!,
      });
      n += listeners.filter((l) => l.type === "keydown").length;
      await cdp.send("Runtime.releaseObject", { objectId: result.objectId! });
    }
    return n;
  } finally {
    await cdp.detach();
  }
}

/** Median ms to dispatch a synthetic keydown on <body> (every document/window listener runs). */
async function syntheticKeydownMs(page: Page): Promise<number> {
  return page.evaluate(() => {
    const samples: number[] = [];
    for (let i = 0; i < 300; i++) {
      const ev = new KeyboardEvent("keydown", {
        key: "F19",
        code: "F19",
        bubbles: true,
        cancelable: true,
      });
      const t0 = performance.now();
      document.body.dispatchEvent(ev);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  });
}

/**
 * Real (trusted) typing into the visible terminal: median ms each keydown spends in
 * window/document/ancestor capture listeners before it reaches xterm's textarea —
 * where every menu root's listener ran.
 */
async function terminalCaptureMs(page: Page): Promise<number> {
  await page.evaluate(() => {
    const ta = [
      ...document.querySelectorAll<HTMLElement>(".xterm-helper-textarea"),
    ].find((t) => t.offsetParent !== null);
    if (!ta) throw new Error("no visible terminal textarea");
    ta.focus();
    const w = window as unknown as { __szKeySamples: number[] };
    w.__szKeySamples = [];
    let t0 = 0;
    window.addEventListener("keydown", () => (t0 = performance.now()), {
      capture: true,
    });
    ta.addEventListener(
      "keydown",
      () => w.__szKeySamples.push(performance.now() - t0),
      {
        capture: true,
      },
    );
  });
  await page.keyboard.type(
    "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
    { delay: 5 },
  );
  return page.evaluate(() => {
    const s = [
      ...(window as unknown as { __szKeySamples: number[] }).__szKeySamples,
    ].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  });
}

test.describe("Closed menus cost nothing per keystroke", () => {
  test("keydown listener count does not grow with kanban cards or open tabs", async ({
    mainWindow,
  }) => {
    test.setTimeout(180_000);
    await resetApp(mainWindow);
    const s = seed(mainWindow);
    const p = await s.createProject({
      name: "Menu Listeners",
      color: "#0ea5e9",
      path: TEST_PROJECT_PATH,
    });
    const abbrev = p.name.slice(0, 2).toUpperCase();
    const createTasks = async (from: number, to: number): Promise<string[]> => {
      const ids: string[] = [];
      for (let i = from; i < to; i++) {
        const t = await s.createTask({
          projectId: p.id,
          title: `Menu task ${i}`,
          status: "in_progress",
          terminalMode: "terminal",
        });
        ids.push(t.id);
      }
      await s.refreshData();
      return ids;
    };
    const cards = () =>
      mainWindow.getByText(/^Menu task \d+$/).filter({ visible: true });

    // Kanban: 3 cards vs 40 cards, every card wrapped in its own context menu.
    const ids = await createTasks(0, 3);
    await goHome(mainWindow);
    await clickProject(mainWindow, abbrev);
    await expect.poll(() => cards().count(), { timeout: 15_000 }).toBe(3);
    const fewCards = await keydownListeners(mainWindow);
    const fewCardsMs = await syntheticKeydownMs(mainWindow);

    ids.push(...(await createTasks(3, 40)));
    await expect.poll(() => cards().count(), { timeout: 15_000 }).toBe(40);
    const manyCards = await keydownListeners(mainWindow);
    const manyCardsMs = await syntheticKeydownMs(mainWindow);

    // Tabs: 3 open vs 40 open (hidden tabs stay mounted with their menus).
    for (const id of ids.slice(0, 3)) await openTaskById(mainWindow, id);
    const fewTabs = await keydownListeners(mainWindow);
    const fewTabsMs = await syntheticKeydownMs(mainWindow);

    await mainWindow.evaluate((all) => {
      const st = (
        window as unknown as TabStoreWindow
      ).__slayzone_tabStore.getState();
      for (const id of all) st.openTaskInBackground(id);
    }, ids);
    await expect
      .poll(
        () =>
          mainWindow.locator('[data-testid="terminal-mode-trigger"]').count(),
        {
          timeout: 90_000,
          intervals: [500, 1_000],
        },
      )
      .toBeGreaterThanOrEqual(ids.length);
    const manyTabs = await keydownListeners(mainWindow);
    const manyTabsMs = await syntheticKeydownMs(mainWindow);

    await openTaskById(mainWindow, ids[0]);
    await expect(
      mainWindow
        .locator(".xterm-helper-textarea")
        .filter({ visible: true })
        .first(),
    ).toBeAttached({ timeout: 20_000 });
    const typingMs = await terminalCaptureMs(mainWindow);

    const summary =
      `document+window keydown listeners: ${fewCards} (3 cards) → ${manyCards} (40 cards); ` +
      `${fewTabs} (3 tabs) → ${manyTabs} (40 tabs)\n` +
      `synthetic keydown median ms: ${fewCardsMs.toFixed(3)} / ${manyCardsMs.toFixed(3)} / ` +
      `${fewTabsMs.toFixed(3)} / ${manyTabsMs.toFixed(3)}\n` +
      `terminal typing, capture-phase median ms (40 tabs): ${typingMs.toFixed(3)}`;
    test.info().annotations.push({ type: "keydown", description: summary });
    console.log(summary);

    // A few listeners come and go with the active view (the 3-tab sample can land
    // before lazy panels attach theirs); per-menu growth was +36 (cards) / +148 (tabs).
    expect.soft(manyCards, summary).toBeLessThanOrEqual(fewCards + 5);
    expect.soft(manyTabs, summary).toBeLessThanOrEqual(fewTabs + 5);
  });

  // The shared tracker must keep upstream's behavior: a pointer-opened menu focuses
  // its content (no item), a keyboard-opened one focuses its first item.
  test("menus keep pointer vs keyboard focus behavior and open at the pointer", async ({
    mainWindow,
  }) => {
    const activeRole = () =>
      mainWindow.evaluate(
        () => document.activeElement?.getAttribute("role") ?? null,
      );

    await resetApp(mainWindow);
    const s = seed(mainWindow);
    const p = await s.createProject({
      name: "Menu Focus",
      color: "#0ea5e9",
      path: TEST_PROJECT_PATH,
    });
    const t = await s.createTask({
      projectId: p.id,
      title: "Menu task 1",
      status: "in_progress",
      terminalMode: "terminal",
    });
    await s.refreshData();

    // Context menu on a kanban card: opens at the right-click point, content focused.
    await showProjectBoard(mainWindow, "ME", "Menu task 1");
    const card = mainWindow
      .getByText("Menu task 1", { exact: true })
      .filter({ visible: true });
    const box = (await card.boundingBox())!;
    const x = box.x + 5;
    const y = box.y + box.height / 2;
    await mainWindow.mouse.click(x, y, { button: "right" });
    const menu = mainWindow.locator('[role="menu"]').filter({ visible: true });
    await expect(menu).toHaveCount(1);
    const menuBox = (await menu.boundingBox())!;
    expect(Math.abs(menuBox.x - x)).toBeLessThan(6);
    expect(Math.abs(menuBox.y - y)).toBeLessThan(6);
    expect(await activeRole()).toBe("menu");
    await mainWindow.keyboard.press("ArrowDown");
    expect(await activeRole()).toBe("menuitem");
    await mainWindow.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // Dropdown opened from the keyboard: first item focused.
    await openTaskById(mainWindow, t.id);
    const trigger = mainWindow
      .locator('[aria-haspopup="menu"]')
      .filter({ visible: true })
      .first();
    await trigger.focus();
    await mainWindow.keyboard.press("Enter");
    await expect(menu).toHaveCount(1);
    expect(await activeRole()).toBe("menuitem");
    await mainWindow.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // Same dropdown opened with the pointer: content focused, no item.
    const tb = (await trigger.boundingBox())!;
    await mainWindow.mouse.click(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await expect(menu).toHaveCount(1);
    expect(await activeRole()).toBe("menu");
    await mainWindow.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });
});
