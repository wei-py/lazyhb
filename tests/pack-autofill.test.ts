import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { TextareaRenderable, TextRenderable, type SelectRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Workspace } from "../src/app.js";

const tick = async (ui: TestRendererSetup) => { await ui.renderOnce(); await ui.flush(); };
const settle = async (ui: TestRendererSetup, predicate: () => boolean | Promise<boolean>) => {
  // UI idle can precede completion of native filesystem and executable work.
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    await tick(ui);
    if (await predicate()) return;
    await fs.stat(tmpdir());
  }
  throw new Error("Native transition did not complete\n" + ui.captureCharFrame());
};
const modal = (ui: TestRendererSetup) => ui.renderer.root.getChildren().find((node) => node !== ui.renderer.root.findDescendantById("workspace"));
const choice = (ui: TestRendererSetup) => modal(ui)?.getChildren().find((node) => node.visible && node.id !== "form-enum" && "getSelectedOption" in node) as SelectRenderable | undefined;
const choose = async (ui: TestRendererSetup, value: string) => {
  await settle(ui, () => !!choice(ui));
  const list = choice(ui)!;
  const index = list.options.findIndex((option) => option.value === value);
  expect(index).toBeGreaterThanOrEqual(0);
  for (let at = list.getSelectedIndex(); at < index; at++) ui.mockInput.pressArrow("down");
  for (let at = list.getSelectedIndex(); at > index; at--) ui.mockInput.pressArrow("up");
  ui.mockInput.pressEnter(); await tick(ui);
};
const escape = async (ui: TestRendererSetup) => {
  const key = once(ui.renderer.keyInput, "keypress");
  ui.mockInput.pressEscape(); await key; await tick(ui);
};
const fieldLabel = (ui: TestRendererSetup) => modal(ui)?.getChildren().find((node) => node instanceof TextRenderable && /^\d+\/\d+ --/.test(node.plainText)) as TextRenderable | undefined;
const fieldKey = (ui: TestRendererSetup) => /^\d+\/\d+ --([\w.-]+)/.exec(fieldLabel(ui)?.plainText ?? "")?.[1];
const field = async (ui: TestRendererSetup, key: string) => {
  await settle(ui, () => !!fieldLabel(ui));
  const total = Number(/^\d+\/(\d+)/.exec(fieldLabel(ui)!.plainText)![1]);
  for (let index = 0; index < total; index++) {
    if (fieldKey(ui) === key) return;
    ui.mockInput.pressArrow("down", { meta: true }); await tick(ui);
  }
  throw new Error("Missing editable field --" + key + "\n" + ui.captureCharFrame());
};
const editor = (ui: TestRendererSetup) => modal(ui)?.getChildren().find((node) => node.visible && node instanceof TextareaRenderable) as TextareaRenderable | undefined;
const focusedMask = (ui: TestRendererSetup) => modal(ui)?.getChildren().find((node) => node.visible && node.focused && node instanceof TextRenderable && !(node instanceof TextareaRenderable)) as TextRenderable | undefined;
const replaceText = async (ui: TestRendererSetup, value: string) => {
  ui.mockInput.pressKey("a", { ctrl: true });
  if (value) await ui.mockInput.typeText(value); else ui.mockInput.pressBackspace();
  await tick(ui);
};

type Fixture = { ui: TestRendererSetup; app: Workspace; project: string; record: string; certificate: string };
const withFixture = async (hasPackage: boolean, run: (fixture: Fixture) => Promise<void>) => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lazyhb-pack-autofill-")));
  const previous = process.env.LAZYHB_STATE_DIR;
  process.env.LAZYHB_STATE_DIR = join(root, "state");
  const ui = await createTestRenderer({ width: 140, height: 44, exitOnCtrlC: false });
  let app: Workspace | undefined;
  try {
    const project = join(root, "Fixture 项目"), certificate = join(project, "signing", "release.keystore");
    const manifest = join(project, "src", "manifest.json");
    await fs.mkdir(join(project, "src"), { recursive: true });
    await fs.writeFile(manifest, JSON.stringify({
      name: "Autofill fixture", appid: "__UNI__FIXTURE",
      "app-plus": { distribute: { android: hasPackage ? { packagename: "com.fixture.manifest" } : {}, ios: { dSYMs: false } } },
    }));
    const android = join(project, ".lazyapp", "platforms", "android");
    await fs.mkdir(join(android, "production"), { recursive: true });
    await fs.writeFile(join(android, "config.json"), JSON.stringify(hasPackage ? { applicationId: "com.fixture.saved" } : {}));
    await fs.writeFile(join(android, "production", "config.json"), JSON.stringify({
      keystore: certificate, alias: "fixture-release",
      password: "SAVED-FIXTURE-PASSWORD", keystorePassword: "SAVED-FIXTURE-KEYSTORE-PASSWORD", storePassword: "SAVED-FIXTURE-STORE-PASSWORD",
    }));
    const record = join(root, "submitted.jsonl");
    const cli = join(root, process.platform === "win32" ? "fixture-cli.exe" : "fixture-cli");
    const source = join(root, "fixture.ts");
    const help = `HBuilderX isolated pack autofill fixture
project list
  Projects
pack
  --project  Project absolute path
  --config  JSON absolute path
  --platform  取值有[android]
  --android.androidpacktype  取值有[0|1] 默认值为:0
  --android.packagename  Android package
  --android.certfile  Android certificate file
  --android.certalias  Android certificate alias
  --android.certpassword  密码
  --android.storepassword  密码
  --dsyms  取值有[true|false]
`;
    // Only this isolated executable can receive a submission; it never invokes HBuilderX.
    await fs.writeFile(source, `import {appendFileSync} from 'node:fs';
const argv=process.argv.slice(2);
if(argv.includes('--help')) console.log(${JSON.stringify(help)});
else if(argv[0]==='version') console.log('pack-autofill-fixture');
else if(argv[0]==='project') console.log('0:project list:OK');
else appendFileSync(${JSON.stringify(record)},JSON.stringify(argv)+'\\n');
`);
    const compilation = Bun.spawn([process.execPath, "build", source, "--compile", "--outfile", cli], { stdout: "ignore", stderr: "pipe" });
    expect(await compilation.exited).toBe(0);
    app = new Workspace(ui.renderer, { project, cli });
    await app.init(); await tick(ui);
    await settle(ui, () => (ui.renderer.root.findDescendantById("task-output") as SelectRenderable).options.some((item) => item.name.includes(cli)));
    await run({ ui, app, project, record, certificate });
  } finally {
    if (app) await app.shutdown();
    await ui.dispose();
    if (previous === undefined) delete process.env.LAZYHB_STATE_DIR; else process.env.LAZYHB_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
};
const startCloud = async ({ ui, app, project }: Fixture, certificateMode: "0" | "1") => {
  const running = app.perform("publish", project);
  await choose(ui, "App 云打包"); await choose(ui, "pack:cloud");
  await choose(ui, "android"); await choose(ui, certificateMode);
  await settle(ui, () => !!fieldLabel(ui));
  return { running };
};

test("guided public-certificate cloud pack suggests editable project values and preserves false until cancellation", async () => {
  await withFixture(true, async (fixture) => {
    const { ui, record } = fixture;
    const { running } = await startCloud(fixture, "1");
    await field(ui, "android.packagename");
    expect(editor(ui)?.plainText).toBe("com.fixture.manifest");
    expect(editor(ui)?.focused).toBe(true);
    expect(fieldLabel(ui)?.plainText).toContain("来源");
    expect(fieldLabel(ui)?.plainText).toContain("src/manifest.json");
    await replaceText(ui, "com.fixture.edited");
    expect(editor(ui)?.plainText).toBe("com.fixture.edited");
    await field(ui, "dsyms");
    const selector = ui.renderer.root.findDescendantById("form-enum") as SelectRenderable;
    expect(selector.visible).toBe(true);
    expect(selector.focused).toBe(true);
    expect(selector.getSelectedOption()?.value).toBe("false");
    expect(fieldLabel(ui)?.plainText).toContain("src/manifest.json");
    await field(ui, "android.packagename");
    expect(editor(ui)?.plainText).toBe("com.fixture.edited");
    ui.mockInput.pressKey("s", { ctrl: true }); await tick(ui);
    await settle(ui, () => !!choice(ui));
    expect(ui.captureCharFrame()).toContain("com.fixture.edited");
    expect(ui.captureCharFrame()).toContain("--dsyms false");
    expect(ui.captureCharFrame()).not.toContain("com.fixture.saved");
    expect(await fs.exists(record)).toBe(false);
    await choose(ui, "no"); await running;
    await settle(ui, () => !modal(ui));
    expect(await fs.exists(record)).toBe(false);
  });
});

test("guided own-certificate cloud pack suggests signing paths and aliases but never reuses saved passwords", async () => {
  await withFixture(true, async (fixture) => {
    const { ui, record, certificate } = fixture;
    const { running } = await startCloud(fixture, "0");
    for (const [key, expected] of [["android.certfile", certificate], ["android.certalias", "fixture-release"]]) {
      await field(ui, key);
      expect(editor(ui)?.plainText).toBe(expected);
      expect(editor(ui)?.focused).toBe(true);
      expect(fieldLabel(ui)?.plainText).toContain("来源");
      expect(fieldLabel(ui)?.plainText).toContain(".lazyapp/platforms/android/production/config.json");
    }
    for (const key of ["android.certpassword", "android.storepassword"]) {
      await field(ui, key);
      expect(editor(ui)).toBeUndefined();
      expect(focusedMask(ui)).toBeDefined();
      expect(focusedMask(ui)!.plainText.replaceAll("│", "")).toBe("");
      expect(ui.captureCharFrame()).not.toContain("SAVED-FIXTURE");
      const typed = "typed-fixture-only";
      await ui.mockInput.typeText(typed); await tick(ui);
      expect(focusedMask(ui)!.plainText).toContain("*".repeat(typed.length));
      expect(ui.captureCharFrame()).not.toContain(typed);
      ui.mockInput.pressKey("u", { ctrl: true }); await tick(ui);
      expect(focusedMask(ui)!.plainText.replaceAll("│", "")).toBe("");
    }
    // Existing required-field validation still focuses the first absent credential.
    ui.mockInput.pressKey("s", { ctrl: true }); await tick(ui);
    expect(fieldKey(ui)).toBe("android.certpassword");
    expect(focusedMask(ui)).toBeDefined();
    expect(choice(ui)).toBeUndefined();
    expect(await fs.exists(record)).toBe(false);
    await escape(ui); await running;
    await settle(ui, () => !modal(ui));
    expect(await fs.exists(record)).toBe(false);
  });
});

test("guided cloud pack without a project package keeps required validation and focuses the editable missing field", async () => {
  await withFixture(false, async (fixture) => {
    const { ui, record } = fixture;
    const { running } = await startCloud(fixture, "1");
    await field(ui, "android.packagename");
    expect(editor(ui)?.plainText).toBe("");
    await field(ui, "dsyms");
    ui.mockInput.pressKey("s", { ctrl: true }); await tick(ui);
    expect(fieldKey(ui)).toBe("android.packagename");
    expect(editor(ui)?.focused).toBe(true);
    expect(editor(ui)?.plainText).toBe("");
    expect(choice(ui)).toBeUndefined();
    expect(await fs.exists(record)).toBe(false);
    await escape(ui); await running;
    await settle(ui, () => !modal(ui));
    expect(await fs.exists(record)).toBe(false);
  });
});
