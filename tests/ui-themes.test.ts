import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { RGBA, TextRenderable, TextareaRenderable, type KeyEvent } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Workspace } from "../src/app.js";
import { Dialogs } from "../src/dialogs.js";
import { loadSettings, saveSettings } from "../src/settings.js";
import { THEME_IDS, themes, type ThemeId, type ThemePreference } from "../src/theme.js";

const tick = async (ui: TestRendererSetup) => { await ui.renderOnce(); await ui.flush(); };
const rgba = (hex: string) => Array.from(RGBA.fromHex(hex).buffer);
const cells = (ui: TestRendererSetup, y: number) => ui.captureSpans().lines[y]!.spans.flatMap((span) =>
  Array.from({ length: span.width }, () => Array.from(span.bg.buffer)));
const assertCanvas = (ui: TestRendererSetup, id: ThemeId) => {
  const color = rgba(themes[id].background);
  for (const y of [0, 1, ui.renderer.height - 3, ui.renderer.height - 2, ui.renderer.height - 1]) {
    const row = cells(ui, y);
    expect(row).toHaveLength(ui.renderer.width);
    for (const bg of row) expect(bg).toEqual(color);
  }
  for (let y = 0; y < ui.renderer.height; y++) {
    const row = cells(ui, y);
    expect(row[0]).toEqual(color);
    expect(row.at(-1)).toEqual(color);
  }
};
const escape = async (ui: TestRendererSetup) => {
  const key = once(ui.renderer.keyInput, "keypress"); ui.mockInput.pressEscape(); await key; await tick(ui);
};
const terminalTheme = async (ui: TestRendererSetup, light: boolean) => {
  // The in-memory test session cannot issue terminal queries; PTY coverage owns the protocol.
  // Simulate the renderer's public getter and emitted event together.
  Object.defineProperty(ui.renderer, "themeMode", { configurable: true, get: () => light ? "light" : "dark" });
  ui.renderer.emit("theme_mode", light ? "light" : "dark");
  await tick(ui);
};

async function isolated(run: () => Promise<void>) {
  const root = await fs.mkdtemp(join(tmpdir(), "lazyhb-themes-"));
  const previous = process.env.LAZYHB_STATE_DIR;
  process.env.LAZYHB_STATE_DIR = root;
  try { await run(); } finally {
    if (previous === undefined) delete process.env.LAZYHB_STATE_DIR; else process.env.LAZYHB_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("all named palettes paint header, footer and canvas blanks after theme changes and resize", async () => isolated(async () => {
  expect(loadSettings().theme).toBe("gruvbox-light");
  const ui = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
  const app = new Workspace(ui.renderer);
  try {
    const order: ThemePreference[] = [...THEME_IDS.slice(1), "auto", THEME_IDS[0]];
    for (const id of order) {
      const resolved = id === "auto" ? "gruvbox-dark" : id;
      expect(loadSettings().theme).toBe(id);
      for (const [width, height] of [[120, 40], [64, 24]]) {
        ui.resize(width!, height!); await tick(ui); assertCanvas(ui, resolved);
      }
      ui.mockInput.pressKey("t", { ctrl: true }); await tick(ui);
    }
  } finally { await app.shutdown(); await ui.dispose(); }
}));

test("selected tabs and settings rows paint trailing cells and empty lines", async () => isolated(async () => {
  saveSettings({ theme: "gruvbox-dark", recentClis: [] });
  const ui = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
  const app = new Workspace(ui.renderer);
  try {
    ui.mockInput.pressKey("3"); await tick(ui);
    const root = ui.renderer.root.findDescendantById("workspace")!;
    const findTab = (node: typeof root): TextRenderable | undefined => {
      if (node instanceof TextRenderable && node.plainText === "常规") return node;
      for (const child of node.getChildren()) { const found = findTab(child); if (found) return found; }
    };
    const tab = findTab(root)!;
    expect(tab).toBeDefined();
    for (const bg of cells(ui, tab.y).slice(tab.x, tab.x + tab.width)) expect(bg).toEqual(rgba("#504945"));
    ui.mockInput.pressKey(","); await tick(ui);
    const row = ui.renderer.root.findDescendantById("settings-theme") as TextRenderable;
    for (let y = row.y; y < row.y + row.height; y++) {
      for (const bg of cells(ui, y).slice(row.x, row.x + row.width)) expect(bg).toEqual(rgba("#504945"));
    }
    await escape(ui);
    assertCanvas(ui, "gruvbox-dark");
  } finally { await app.shutdown(); await ui.dispose(); }
}));

test("auto persists independently, follows startup and live terminal mode, and releases its listener", async () => isolated(async () => {
  saveSettings({ theme: "auto", recentClis: [] });
  expect(loadSettings().theme).toBe("auto");
  const ui = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
  const initialListeners = ui.renderer.listenerCount("theme_mode");
  let app = new Workspace(ui.renderer);
  try {
    await tick(ui); assertCanvas(ui, "gruvbox-dark"); // Unknown terminal mode is conservatively dark.
    expect(ui.captureCharFrame()).toContain("自动（终端）");
    await terminalTheme(ui, true); assertCanvas(ui, "gruvbox-light");
    await terminalTheme(ui, false); assertCanvas(ui, "gruvbox-dark");
    expect(loadSettings().theme).toBe("auto");
    ui.mockInput.pressKey(","); await tick(ui);
    expect(ui.captureCharFrame()).toContain("自动（终端）");
    ui.mockInput.pressArrow("right"); await tick(ui);
    expect(loadSettings().theme).toBe("gruvbox-dark");
    await terminalTheme(ui, true); assertCanvas(ui, "gruvbox-dark"); // Named themes stay fixed.
    ui.mockInput.pressArrow("left"); await tick(ui);
    expect(loadSettings().theme).toBe("auto");
    await escape(ui); assertCanvas(ui, "gruvbox-light");
    ui.renderer.destroy(); await ui.renderer.closed;
    expect(ui.renderer.listenerCount("theme_mode")).toBe(initialListeners);
  } finally { await app.shutdown(); await ui.dispose(); }

  const restarted = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
  await terminalTheme(restarted, true);
  app = new Workspace(restarted.renderer);
  try {
    await tick(restarted); assertCanvas(restarted, "gruvbox-light");
    await terminalTheme(restarted, false); assertCanvas(restarted, "gruvbox-dark");
    await app.shutdown();
    expect(restarted.renderer.listenerCount("theme_mode")).toBe(0);
  } finally { await app.shutdown(); await restarted.dispose(); }
}));

test("live theme updates repaint an open form without replacing input or credentials", async () => {
  const ui = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
  const dialogs = new Dialogs(ui.renderer, () => {}, themes["gruvbox-light"]);
  const handleKey = (key: KeyEvent) => { dialogs.handleKey(key); };
  ui.renderer.keyInput.on("keypress", handleKey);
  try {
    const form = dialogs.form("Theme transition", [{ key: "value", label: "Value", value: "retained" }]);
    await tick(ui);
    const modal = ui.renderer.root.getChildren()[0]!;
    const editor = modal.getChildren().find((node) => node instanceof TextareaRenderable) as TextareaRenderable;
    await ui.mockInput.typeText(" input"); await tick(ui);
    const input = editor.plainText;
    for (const id of ["gruvbox-dark", "gruvbox-light"] as const) {
      dialogs.setTheme(themes[id]); await tick(ui);
      expect(editor.plainText).toBe(input);
      expect(Array.from(editor.textColor.buffer)).toEqual(rgba(themes[id].foreground));
      // Include a blank cell at the far edge of the editor, not merely the text glyphs.
      expect(cells(ui, editor.y)[editor.x + editor.width - 1]).toEqual(rgba(themes[id].inputBackground));
      const label = modal.getChildren().find((node) => node instanceof TextRenderable && node.plainText.includes("Value")) as TextRenderable;
      expect(Array.from(label.fg.buffer)).toEqual(rgba(themes[id].foreground));
      expect(cells(ui, label.y)[label.x + label.width - 1]).toEqual(rgba(themes[id].surface));
    }
    dialogs.cancelActive(); await form;
    const secret = dialogs.form("Credentials", [{ key: "secret", label: "Secret", value: "not-on-screen", secret: true }]);
    await tick(ui);
    dialogs.setTheme(themes["gruvbox-dark"]); await tick(ui);
    expect(ui.captureCharFrame()).not.toContain("not-on-screen");
    ui.mockInput.pressKey("s", { ctrl: true });
    expect((await secret)?.secret).toBe("not-on-screen");
  } finally {
    ui.renderer.keyInput.off("keypress", handleKey);
    dialogs.cancelActive(); await ui.dispose();
  }
});
