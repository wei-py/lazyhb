import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { InputRenderable, SelectRenderable, TextRenderable } from "@opentui/core";
import { Dialogs } from "../src/dialogs.js";
import { Workspace } from "../src/app.js";
import { ProjectRegistry } from "../src/projects.js";

const tick = async (ui: TestRendererSetup) => { await ui.renderOnce(); await ui.flush(); };

test("searchable choice never submits empty or unavailable results and keeps input navigation literal", async () => {
  const ui = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
  const dialogs = new Dialogs(ui.renderer, () => {});
  const onKey = (key: Parameters<Dialogs["handleKey"]>[0]) => dialogs.handleKey(key);
  ui.renderer.keyInput.on("keypress", onKey);
  try {
    const picking = dialogs.choice("Operations", [
      { value: "save", label: "配置 · 保存", description: "Save manifest", disabledReason: "Task still running" },
      { value: "properties", label: "项目 · 属性", description: "Inspect project" },
      { value: "plugin", label: "资源 · 插件", description: "Import plugin" },
    ], undefined, true);
    await tick(ui);
    const input = ui.renderer.root.findDescendantById("choice-search") as InputRenderable;
    const results = ui.renderer.root.findDescendantById("choice-results") as SelectRenderable;
    await ui.mockInput.typeText("nothing?[]123"); await tick(ui);
    expect(input.value).toBe("nothing?[]123");
    expect(results.options).toEqual([]);
    ui.mockInput.pressEnter(); await tick(ui);
    expect(dialogs.active).toBe(true);
    ui.mockInput.pressKey("a", { ctrl: true });
    await ui.mockInput.typeText("SAVE"); await tick(ui);
    expect(results.getSelectedOption()?.value).toBe("save");
    ui.mockInput.pressEnter(); await tick(ui);
    expect(dialogs.active).toBe(true);
    ui.mockInput.pressKey("a", { ctrl: true });
    await ui.mockInput.typeText("项目 inspect"); await tick(ui);
    ui.mockInput.pressEnter(); await tick(ui);
    expect(await picking).toBe("properties");
    expect(dialogs.active).toBe(false);

    const second = dialogs.choice("Navigate", [
      { value: "one", label: "One" }, { value: "two", label: "Two" },
    ], undefined, true);
    await tick(ui);
    ui.mockInput.pressArrow("down"); await tick(ui);
    expect((ui.renderer.root.findDescendantById("choice-search") as InputRenderable).focused).toBe(true);
    ui.mockInput.pressEnter(); await tick(ui);
    expect(await second).toBe("two");
  } finally {
    dialogs.cancelActive();
    ui.renderer.keyInput.off("keypress", onKey);
    await ui.dispose();
  }
});

test("operation search preserves highlighted project target and Escape restores the calling panel", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lazyhb-palette-")));
  const previous = process.env.LAZYHB_STATE_DIR;
  process.env.LAZYHB_STATE_DIR = join(root, "state");
  const ui = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
  let app: Workspace | undefined;
  try {
    const a = join(root, "A"), b = join(root, "B");
    for (const path of [a, b]) {
      await fs.mkdir(path); await fs.writeFile(join(path, "manifest.json"), '{"name":"Fixture"}');
      await new ProjectRegistry().add(path);
    }
    app = new Workspace(ui.renderer, { project: a, cli: join(root, "no-cli") });
    await app.init(); await tick(ui);
    ui.mockInput.pressKey("1"); await tick(ui);
    const projects = ui.renderer.root.findDescendantById("projects") as SelectRenderable;
    projects.setSelectedIndex(1);
    const searching = app.perform("more"); await tick(ui);
    await ui.mockInput.typeText("properties"); await tick(ui);
    ui.mockInput.pressEnter();
    for (let index = 0; index < 100; index++) {
      await tick(ui);
      if (!ui.renderer.root.findDescendantById("choice-search") && ui.captureCharFrame().includes(b)) break;
      await fs.stat(root);
    }
    expect(ui.captureCharFrame()).toContain(b);
    const title = ui.renderer.root.findDescendantById("workspace-title") as TextRenderable;
    expect(title.plainText).toContain(a);
    ui.mockInput.pressEscape(); await tick(ui); await searching;
    expect(projects.focused).toBe(true);
    ui.mockInput.pressKey("3"); await tick(ui);
    const cancelled = app.perform("more"); await tick(ui);
    await ui.mockInput.typeText("plugin"); await tick(ui);
    ui.mockInput.pressEscape(); await tick(ui); await cancelled;
    expect(ui.renderer.root.findDescendantById("fields")!.focused).toBe(true);
    expect(title.plainText).toContain(a);
  } finally {
    if (app) await app.shutdown();
    await ui.dispose();
    if (previous === undefined) delete process.env.LAZYHB_STATE_DIR;
    else process.env.LAZYHB_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("enum form fields preserve explicit false, omitted defaults and field navigation", async () => {
  const ui = await createTestRenderer({ width: 100, height: 30, exitOnCtrlC: false });
  const dialogs = new Dialogs(ui.renderer, () => {});
  const handler = (key: Parameters<Dialogs["handleKey"]>[0]) => dialogs.handleKey(key);
  ui.renderer.keyInput.on("keypress", handler);
  try {
    const form = dialogs.form("Device parameters", [
      { key: "native-log", label: "--native-log", choices: ["true", "false"], defaultValue: "false" },
      { key: "pagePath", label: "--pagePath" },
    ]);
    await tick(ui);
    const selector = ui.renderer.root.findDescendantById("form-enum") as SelectRenderable;
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("down"); await tick(ui);
    ui.mockInput.pressEnter(); await tick(ui);
    await ui.mockInput.typeText("pages/index");
    ui.mockInput.pressArrow("up", { meta: true }); await tick(ui);
    expect(selector.getSelectedOption()?.value).toBe("false");
    expect(selector.focused).toBe(true);
    ui.mockInput.pressArrow("down", { meta: true }); await tick(ui);
    ui.mockInput.pressKey("s", { ctrl: true }); await tick(ui);
    expect(await form).toEqual({ "native-log": "false", pagePath: "pages/index" });

    const required = dialogs.form("Required enum", [
      { key: "mode", label: "--mode", choices: ["full", "lastBuild"], allowOmit: false },
    ]);
    await tick(ui);
    ui.mockInput.pressKey("s", { ctrl: true }); await tick(ui);
    expect(dialogs.active).toBe(true);
    const requiredList = ui.renderer.root.findDescendantById("form-enum") as SelectRenderable;
    await ui.mockMouse.click(requiredList.x + 2, requiredList.y + 2); await tick(ui);
    ui.mockInput.pressKey("s", { ctrl: true }); await tick(ui);
    expect(await required).toEqual({ mode: "lastBuild" });

    const omitted = dialogs.form("Optional enum", [
      { key: "native-log", label: "--native-log", choices: ["true", "false"], defaultValue: "false" },
    ]);
    await tick(ui);
    ui.mockInput.pressKey("s", { ctrl: true }); await tick(ui);
    expect(await omitted).toEqual({ "native-log": "" });
  } finally {
    dialogs.cancelActive();
    ui.renderer.keyInput.off("keypress", handler);
    await ui.dispose();
  }
});
