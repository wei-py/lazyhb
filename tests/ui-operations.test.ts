import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { measureEditText, type SelectRenderable, type TextRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Workspace } from "../src/app.js";
import { ProjectRegistry } from "../src/projects.js";
import { Dialogs } from "../src/dialogs.js";
import { HXClient, CLICancelledError } from "../src/hx.js";

const tick = async (ui: TestRendererSetup) => { await ui.renderOnce(); await ui.flush(); };
const settle = async (ui: TestRendererSetup, predicate: () => boolean | Promise<boolean>) => {
  // Renderer waitFor stops at UI idle, before native subprocess/filesystem completion.
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    await tick(ui);
    if (await predicate()) return;
    await fs.stat(tmpdir());
  }
  throw new Error("Native transition did not complete\n" + ui.captureCharFrame());
};
const escape = async (ui: TestRendererSetup) => {
  const key = once(ui.renderer.keyInput, "keypress"); ui.mockInput.pressEscape(); await key; await tick(ui);
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
const submitParameters = async (ui: TestRendererSetup, values: Record<string, string> = {}) => {
  await settle(ui, () => !!modal(ui));
  if (choice(ui)) return; // No editable fields: the workflow goes directly to final confirmation.
  const current = () => modal(ui)?.getChildren().map((node) => "plainText" in node ? String(node.plainText) : "").find((text) => /^\d+\/\d+ /.test(text));
  const total = Number(/^(\d+)\/(\d+) /.exec(current() ?? "")?.[2] ?? 0);
  for (let field = 0; field < total; field++) {
    const key = /^\d+\/\d+ --([\w.-]+)/.exec(current() ?? "")?.[1];
    if (key && Object.hasOwn(values, key)) {
      const selector = ui.renderer.root.findDescendantById("form-enum") as SelectRenderable | undefined;
      if (selector?.visible) {
        const target = selector.options.findIndex((option) => option.value === values[key]);
        expect(target).toBeGreaterThanOrEqual(0);
        for (let at = selector.getSelectedIndex(); at < target; at++) ui.mockInput.pressArrow("down");
        for (let at = selector.getSelectedIndex(); at > target; at--) ui.mockInput.pressArrow("up");
      } else {
        ui.mockInput.pressKey("a", { ctrl: true });
        if (values[key]) await ui.mockInput.typeText(values[key]); else ui.mockInput.pressBackspace();
      }
    }
    ui.mockInput.pressArrow("down", { meta: true }); await tick(ui);
  }
  ui.mockInput.pressKey("s", { ctrl: true }); await tick(ui);
};
const saveProof = async (name: string, content: string) => {
  if (!process.env.LAZYHB_UI_PROOF_DIR) return;
  await fs.mkdir(process.env.LAZYHB_UI_PROOF_DIR, { recursive: true });
  await fs.writeFile(join(process.env.LAZYHB_UI_PROOF_DIR, name), content);
};
const selectionProof = async (ui: TestRendererSetup, list: SelectRenderable, name: string) => {
  const frame = ui.captureSpans();
  const color = (y: number) => {
    let x = 0;
    for (const span of frame.lines[y].spans) {
      x += span.width;
      if (x > list.x + 4) return JSON.stringify(span.bg);
    }
    throw new Error("Missing captured list cell");
  };
  const selected = color(list.y + list.getSelectedIndex());
  const unselected = color(list.y + (list.getSelectedIndex() === 0 ? 1 : 0));
  const blank = color(list.y + list.height - 1);
  expect(selected).not.toBe(unselected);
  expect(unselected).toBe(blank);
  await saveProof(name, JSON.stringify({ selected, unselected, blank, lines: frame.lines.slice(list.y, list.y + list.height) }, null, 2));
};

// All state transitions enter through actual workspace input and rendered dialog controls.
test("project context binds highlighted target, preserves dirty cancellation, and spawns only confirmed argv", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lazyhb-operations-")));
  const previous = process.env.LAZYHB_STATE_DIR;
  process.env.LAZYHB_STATE_DIR = join(root, "state");
  const ui = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
  let app: Workspace | undefined;
  try {
    const a = join(root, "A 项目"), b = join(root, "B Project");
    for (const path of [a, b]) {
      await fs.mkdir(path);
      await fs.writeFile(join(path, "manifest.json"), JSON.stringify({ name: path === a ? "中英ABC" : "Beta", appid: "fixture", description: "说明", versionName: "1.0.0", versionCode: "100" }));
      await new ProjectRegistry().add(path);
    }
    const record = join(root, "argv.jsonl"), release = join(root, "release");
    const cli = join(root, process.platform === "win32" ? "fixture-cli.exe" : "fixture-cli");
    const fixtureSource = join(root, "fixture.ts");
    const help = `HBuilderX isolated UI fixture\nproject list\n  List projects\nlaunch app-android\n  Device launch\n  --project  Project selector\n  --ui  取值有[false|true]\n  --compile  取值有[false|true]\nlaunch app-harmony\n  Compile only fixture\n  --project  Project selector\n  --ui  取值有[false]\n  --compile  取值有[true]\npublish web\n  Publish web\n  --projectPath  Project selector\npublish unsafe\n  No explicit project selector\n  --path  Output directory\npack status\n  Global status\n`;
    await fs.writeFile(fixtureSource, `import {appendFileSync,existsSync,watch} from 'node:fs';\nimport {once} from 'node:events';\nconst a=process.argv.slice(2);\nif(a.includes('--help')) console.log(${JSON.stringify(help)});\nelse if(a[0]==='version') console.log('fixture-1');\nelse if(a[0]==='project') console.log('0:project list:OK');\nelse {const watcher=watch(${JSON.stringify(root)}); appendFileSync(${JSON.stringify(record)},JSON.stringify(a)+'\\n'); while(!existsSync(${JSON.stringify(release)})) await once(watcher,'change'); watcher.close();}\n`);
    const compilation = Bun.spawn([process.execPath, "build", fixtureSource, "--compile", "--outfile", cli], { stdout: "ignore", stderr: "pipe" });
    expect(await compilation.exited).toBe(0);
    const fixtureHelp = Bun.spawnSync([cli, "--help"], { stdout: "pipe", stderr: "pipe" });
    expect(fixtureHelp.exitCode).toBe(0);
    expect(fixtureHelp.stdout.toString()).toContain("project list");
    app = new Workspace(ui.renderer, { project: a, cli });
    await app.init(); await tick(ui);
    await settle(ui, () => (ui.renderer.root.findDescendantById("task-output") as SelectRenderable).options.some((item) => item.name.includes("CLI 已连接")));
    const fields = ui.renderer.root.findDescendantById("fields") as SelectRenderable;
    ui.mockInput.pressKey("3"); await tick(ui);
    ui.mockInput.pressArrow("down"); ui.mockInput.pressArrow("down"); await tick(ui);
    const selectedPath = fields.getSelectedOption()?.description.split("\n")[0];
    for (const [width, height] of [[120, 40], [100, 30], [64, 24]]) {
      ui.resize(width, height); await tick(ui);
      expect(fields.getSelectedOption()?.description.split("\n")[0]).toBe(selectedPath);
      const frame = ui.captureCharFrame();
      expect(frame.split("\n").every((line) => measureEditText(line, { widthMethod: ui.renderer.widthMethod }) <= width)).toBe(true);
      await saveProof(`fields-${width}x${height}.txt`, frame);
      const lines = frame.split("\n");
      const valueColumn = (value: string) => {
        const line = lines.find((row) => row.includes(value))!;
        return measureEditText(line.slice(0, line.indexOf(value)), { widthMethod: ui.renderer.widthMethod });
      };
      expect(valueColumn("中英ABC")).toBe(valueColumn("fixture"));
      if (width === 120) await selectionProof(ui, fields, "fields-spans.json");
      ui.mockInput.pressKey("2"); await tick(ui);
      await saveProof(`actions-${width}x${height}.txt`, ui.captureCharFrame());
      const operations = ui.renderer.root.findDescendantById("overview-actions") as SelectRenderable;
      if (width === 120) await selectionProof(ui, operations, "actions-spans.json");
      ui.mockInput.pressKey("3"); await tick(ui);
    }
    ui.resize(120, 40); await tick(ui);
    const editing = app.perform("edit"); await settle(ui, () => !!modal(ui));
    ui.mockInput.pressKey("a", { ctrl: true }); await ui.mockInput.typeText("未保存的A草稿");
    ui.mockInput.pressKey("s", { ctrl: true }); await editing; await tick(ui);
    expect(fields.getSelectedOption()?.description.split("\n")[0]).toBe(selectedPath);
    expect(await fs.readFile(join(a, "manifest.json"), "utf8")).not.toContain("未保存的A草稿");
    ui.mockInput.pressKey("1"); await tick(ui);
    const projects = ui.renderer.root.findDescendantById("projects") as SelectRenderable;
    const bIndex = projects.options.findIndex((option) => option.value === b);
    while (projects.getSelectedIndex() < bIndex) ui.mockInput.pressArrow("down");
    while (projects.getSelectedIndex() > bIndex) ui.mockInput.pressArrow("up");
    await ui.mockMouse.click(projects.x + 3, projects.y + bIndex, 2); await tick(ui);
    expect(choice(ui)).toBeDefined();
    expect(ui.captureCharFrame()).toContain("B Project");
    await saveProof("context-target-b.txt", ui.captureCharFrame());
    await escape(ui);
    expect((ui.renderer.root.findDescendantById("workspace-title") as TextRenderable).plainText).toContain(a);
    ui.mockInput.pressKey("o"); await tick(ui); await choose(ui, "run");
    await choose(ui, "cancel"); await settle(ui, () => !modal(ui));
    expect((ui.renderer.root.findDescendantById("workspace-title") as TextRenderable).plainText).toContain(a);
    expect(await fs.exists(record)).toBe(false);
    expect(await fs.readFile(join(b, "manifest.json"), "utf8")).not.toContain("未保存的A草稿");
    // Save A without losing selection, then choose B's actual operation.
    await app.perform("save"); await tick(ui);
    expect(await fs.readFile(join(a, "manifest.json"), "utf8")).toContain("未保存的A草稿");
    ui.mockInput.pressKey("o"); await tick(ui); await choose(ui, "run");
    await choose(ui, "app-android"); await choose(ui, "launch app-android:compile");
    await settle(ui, () => !!choice(ui));
    // Compilation is a separate locked mode, and empty parameter pages are skipped.
    expect(ui.captureCharFrame()).toContain("开发仅编译");
    expect(ui.captureCharFrame()).toContain(b);
    await saveProof("compile-confirm.txt", ui.captureCharFrame());
    await choose(ui, "no"); await settle(ui, () => !modal(ui));
    expect(await fs.exists(record)).toBe(false);
    // A running task keeps its captured project while the workspace browses another project.
    const running = app.perform("run", b); await choose(ui, "app-android"); await choose(ui, "launch app-android:run");
    await choose(ui, "yes");
    await settle(ui, () => fs.exists(record));
    const argv = JSON.parse((await fs.readFile(record, "utf8")).trim());
    expect(argv).toContain(b); expect(argv).not.toContain(a);
    expect(argv[argv.indexOf("--project") + 1]).toBe(b);
    ui.mockInput.pressKey("1"); await tick(ui);
    const aIndex = projects.options.findIndex((option) => option.value === a);
    projects.setSelectedIndex(aIndex); ui.mockInput.pressEnter(); await tick(ui);
    await settle(ui, () => (ui.renderer.root.findDescendantById("workspace-title") as TextRenderable).plainText.includes(a));
    await fs.writeFile(release, "release");
    await running; await tick(ui);
    await settle(ui, () => !(ui.renderer.root.findDescendantById("task-records") as SelectRenderable).options.some((item) => item.name.includes("运行中")));
    ui.mockInput.pressKey("4"); await tick(ui);
    const publishing = app.perform("publish", b); await choose(ui, "web"); await choose(ui, "publish web:web");
    await choose(ui, "yes");
    await settle(ui, async () => (await fs.readFile(record, "utf8")).trim().split("\n").length === 2);
    const records = (await fs.readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records[1][records[1].indexOf("--projectPath") + 1]).toBe(b);
    await publishing; await tick(ui);
    const unbound = app.perform("publish"); await choose(ui, "unsafe"); await choose(ui, "publish unsafe:cli");
    await settle(ui, () => !!choice(ui));
    await choose(ui, "back"); await escape(ui); await unbound; await tick(ui);
    expect((await fs.readFile(record, "utf8")).trim().split("\n")).toHaveLength(2);
    const compileOnly = app.perform("run", b); await choose(ui, "app-harmony"); await choose(ui, "launch app-harmony:compile");
    await settle(ui, () => !!choice(ui));
    expect(ui.captureCharFrame()).toContain("开发仅编译");
    await saveProof("compile-mode-locked.txt", ui.captureCharFrame());
    await choose(ui, "yes"); await compileOnly;
    await settle(ui, async () => (await fs.readFile(record, "utf8")).trim().split("\n").length === 3);
    const finalRecords = (await fs.readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(finalRecords).toHaveLength(3);
    expect(finalRecords[2][finalRecords[2].indexOf("--compile") + 1]).toBe("true");
    expect(finalRecords[2][finalRecords[2].indexOf("--project") + 1]).toBe(b);
    await saveProof("argv.jsonl", await fs.readFile(record, "utf8"));
  } finally {
    if (app) await app.shutdown(); await ui.dispose();
    if (previous === undefined) delete process.env.LAZYHB_STATE_DIR; else process.env.LAZYHB_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("guided modes bind real fixture argv, conditional fields and confirmed cloud configuration snapshots", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lazyhb-workflows-")));
  const previous = process.env.LAZYHB_STATE_DIR;
  process.env.LAZYHB_STATE_DIR = join(root, "state");
  const ui = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
  let app: Workspace | undefined;
  try {
    const project = join(root, "B 捕获项目"), other = join(root, "A other");
    for (const path of [project, other]) {
      await fs.mkdir(path); await fs.writeFile(join(path, "manifest.json"), '{"name":"Fixture","appid":"fixture"}');
    }
    const record = join(root, "records.jsonl"), helpFile = join(root, "help.txt");
    const cli = join(root, process.platform === "win32" ? "fixture-cli.exe" : "fixture-cli");
    const source = join(root, "fixture.ts");
    const help = `HBuilderX isolated workflow fixture
project list
  Projects
devices list
  --platform  取值有[android|ios-iPhone|app-harmony|mp-harmony]
launch app-android
  --project  Project
  --ui  取值有[true|false] 默认值为:false
  --compile  取值有[true|false] 默认值为:false
  --deviceId  Serial
  --playground  取值有[standard|custom] 默认值为:standard
  --pagePath  Page
launch web
  --project  Project
  --ui  取值有[true|false]
  --compile  取值有[true|false]
  --browser  取值有[Built|Chrome]
publish app-android
  --project  Project
  --type  本地打包类型，固定为 appResource
publish app-android
  --project  Project
  --type  打包类型，固定为 wgt
  --name  Export name
  --path  Export directory
publish web
  --project  Project
  --webHosting  取值有[true|false] 默认值为:false
  --ssr  取值有[true|false] 默认值为:false
  --provider  取值有[aliyun|alipay|tcb]
  --spaceId  Space
  --ssrHost  Only multiple domains
publish mp-weixin
  --project  Project
  --upload  取值有[true|false] 默认值为:false
  --subPackage  subPackage 和 upload 只能填写其中一个
  --appid  Upload app
  --privatekey  Upload key file
  --robot  1 到 30
pack
  --project  绝对路径，必填
  --config  JSON absolute path
  --platform  取值有[android|ios]
  --iscustom  取值有[true|false]
  --android.androidpacktype  取值有[0|1] 默认值为:0
  --android.packagename  打包 Android 时必填
  --android.certalias  Own certificate
  --android.certfile  Own file
  --android.certpassword  密码
  --android.storepassword  密码
  --ios.bundle  打包 iOS 时必填
  --ios.profile  Custom profile
  --ios.certfile  Custom p12
  --ios.certpassword  密码
pack status
  --project  Project
pack cancel
  --project  Project
  --platform  取值有[app-ios|app-android]
pack app-harmony
  --project  Project
`;
    await fs.writeFile(helpFile, help);
    await fs.writeFile(source, `import {readFileSync,appendFileSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
const argv=process.argv.slice(2);
if(argv.includes('--help')) console.log(readFileSync(${JSON.stringify(helpFile)},'utf8'));
else if(argv[0]==='project') console.log('0:project list:OK');
else {
 const path=argv[0]==='pack'&&argv[1]==='--config'?argv[2]:undefined;
 const configuration=path?JSON.parse(readFileSync(path,'utf8')):undefined;
 appendFileSync(${JSON.stringify(record)},JSON.stringify({argv,configuration,configPath:path,fileMode:path?statSync(path).mode&511:undefined,directoryMode:path?statSync(dirname(path)).mode&511:undefined})+'\\n');
 if(argv[0]==='devices') console.log('fixture-device-42: USB Android device');
 if(configuration?.ios?.certpassword) console.log('credential='+configuration.ios.certpassword);
}`);
    const compilation = Bun.spawn([process.execPath, "build", source, "--compile", "--outfile", cli], { stdout: "ignore", stderr: "pipe" });
    expect(await compilation.exited).toBe(0);
    app = new Workspace(ui.renderer, { project, cli }); await app.init(); await tick(ui);
    await settle(ui, () => (ui.renderer.root.findDescendantById("task-output") as SelectRenderable).options.some((item) => item.name.includes("CLI 已连接")));
    const records = async (): Promise<{ argv: string[]; configuration?: Record<string, any>; configPath?: string; fileMode?: number; directoryMode?: number }[]> => {
      await settle(ui, () => !(ui.renderer.root.findDescendantById("task-records") as SelectRenderable).options.some((item) => /运行中|停止中/.test(item.name)));
      return await fs.exists(record) ? (await fs.readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line)) : [];
    };
    const start = async (kind: "run" | "publish", target: string, mode: string) => {
      const running = app!.perform(kind, project); await choose(ui, target); await choose(ui, mode); return { running };
    };
    const cancelledWeb = await start("run", "web", "launch web:run");
    await choose(ui, "Chrome");
    await submitParameters(ui); await choose(ui, "no"); await cancelledWeb.running;
    expect(await records()).toHaveLength(0);
    const development = await start("run", "web", "launch web:compile");
    await submitParameters(ui); await choose(ui, "no"); await development.running; expect(await records()).toHaveLength(0);
    const device = await start("run", "app-android", "launch app-android:run");
    expect(choice(ui)!.getSelectedOption()!.value).toBe("standard");
    await choose(ui, "custom"); await choose(ui, "query");
    await settle(ui, () => ui.captureCharFrame().includes("fixture-device-42"));
    await choose(ui, "manual");
    await ui.mockInput.typeText("fixture-device-42"); ui.mockInput.pressKey("s", { ctrl: true }); await tick(ui);
    await submitParameters(ui, { pagePath: "pages/index/index" }); await choose(ui, "yes"); await device.running;
    const deviceArgv = (await records())[1].argv;
    expect(deviceArgv).toEqual(["launch", "app-android", "--ui", "false", "--compile", "false", "--project", project, "--playground", "custom", "--deviceId", "fixture-device-42", "--pagePath", "pages/index/index"]);
    const resource = await start("publish", "app-android", "publish app-android:appResource");
    await submitParameters(ui); await saveProof("native-resource-confirm.txt", ui.captureCharFrame());
    expect(ui.captureCharFrame()).toContain("不是最终");
    await choose(ui, "yes"); await resource.running;
    const wgt = await start("publish", "app-android", "publish app-android:wgt");
    await submitParameters(ui, { name: "fixture.wgt", path: join(root, "exports") });
    expect(ui.captureCharFrame()).toContain("WGT"); await saveProof("wgt-confirm.txt", ui.captureCharFrame());
    await choose(ui, "yes"); await wgt.running;
    const wgtArgv = (await records()).at(-1)!.argv;
    expect(wgtArgv[wgtArgv.indexOf("--type") + 1]).toBe("wgt");
    expect(wgtArgv[wgtArgv.indexOf("--path") + 1]).toBe(join(root, "exports"));
    const hosting = await start("publish", "web", "publish web:hosting");
    await choose(ui, "false"); await submitParameters(ui);
    expect(choice(ui)).toBeUndefined();
    expect(ui.captureCharFrame()).toContain("provider");
    await submitParameters(ui, { provider: "aliyun", spaceId: "fixture-space" });
    await choose(ui, "yes"); await hosting.running;
    expect((await records()).at(-1)!.argv).toEqual(["publish", "web", "--webHosting", "true", "--project", project, "--ssr", "false", "--provider", "aliyun", "--spaceId", "fixture-space"]);
    const upload = await start("publish", "mp-weixin", "publish mp-weixin:upload");
    await submitParameters(ui); expect(choice(ui)).toBeUndefined();
    await submitParameters(ui, { appid: "wx-fixture", privatekey: join(root, "ci.key"), robot: "31" }); expect(choice(ui)).toBeUndefined();
    await submitParameters(ui, { robot: "2" }); await saveProof("ci-upload-confirm.txt", ui.captureCharFrame());
    await choose(ui, "yes"); await upload.running;
    const uploadArgv = (await records()).at(-1)!.argv;
    expect(uploadArgv[uploadArgv.indexOf("--upload") + 1]).toBe("true"); expect(uploadArgv).not.toContain("--subPackage");
    const subpackage = await start("publish", "mp-weixin", "publish mp-weixin:subpackage");
    await submitParameters(ui, { subPackage: "fixture-sub" }); await choose(ui, "yes"); await subpackage.running;
    expect((await records()).at(-1)!.argv).toEqual(["publish", "mp-weixin", "--project", project, "--subPackage", "fixture-sub"]);
    const cloud = await start("publish", "App 云打包", "pack:cloud");
    expect(choice(ui)!.options.map((option) => option.value)).toEqual(["android", "ios"]);
    await choose(ui, "android"); await choose(ui, "1");
    expect(choice(ui)!.getSelectedOption()!.value).toBe("false"); await choose(ui, "false");
    await submitParameters(ui); expect(choice(ui)).toBeUndefined();
    await submitParameters(ui, { "android.packagename": "com.fixture.test" });
    expect(ui.captureCharFrame()).toContain("正式应用"); await saveProof("cloud-package-confirm.txt", ui.captureCharFrame());
    await choose(ui, "yes"); await cloud.running;
    const packageRecord = (await records()).at(-1)!;
    expect(packageRecord.configuration?.project).toBe(project);
    expect(packageRecord.configuration?.android).toEqual({ androidpacktype: "1", packagename: "com.fixture.test" });
    expect(packageRecord.argv).toEqual(["pack", "--config", packageRecord.configPath!]);
    const ios = await start("publish", "App 云打包", "pack:cloud");
    await choose(ui, "ios"); await choose(ui, "true"); await choose(ui, "existing");
    await submitParameters(ui, { "ios.bundle": "com.fixture.ios" });
    expect(ui.captureCharFrame()).toContain("自定义云调试基座"); await saveProof("cloud-custom-base-confirm.txt", ui.captureCharFrame());
    await choose(ui, "no"); await ios.running;
    const secret = "FIXTURE-CONFIDENTIAL-CREDENTIAL", config = join(root, "pack.json");
    await fs.writeFile(config, JSON.stringify({ project: other, platform: "ios", ios: { bundle: "com.fixture.ios", certpassword: secret } }));
    const snapshot = await start("publish", "App 云打包", "pack:config");
    await submitParameters(ui, { config });
    await settle(ui, () => ui.captureCharFrame().includes("必须与捕获"));
    expect(choice(ui)).toBeUndefined();
    expect(ui.captureCharFrame()).not.toContain(secret);
    await fs.writeFile(config, JSON.stringify({ project, platform: "ios", ios: { bundle: "com.fixture.ios", certpassword: secret } }));
    await submitParameters(ui);
    await settle(ui, () => !!choice(ui)); expect(ui.captureCharFrame()).not.toContain(secret);
    await saveProof("cloud-config-confirm.txt", ui.captureCharFrame());
    // The already-displayed confirmation binds the snapshot, even if the source now selects A.
    await fs.writeFile(config, JSON.stringify({ project: other, platform: "android", android: { packagename: "com.other" } }));
    await choose(ui, "yes"); await snapshot.running;
    const snapshotRecord = (await records()).at(-1)!;
    expect(snapshotRecord.configuration?.project).toBe(project);
    expect(snapshotRecord.configuration?.ios.certpassword).toBe(secret);
    expect(snapshotRecord.configPath).not.toBe(config);
    expect(await fs.exists(snapshotRecord.configPath!)).toBe(false);
    if (process.platform !== "win32") { expect(snapshotRecord.fileMode).toBe(0o600); expect(snapshotRecord.directoryMode).toBe(0o700); }
    expect((ui.renderer.root.findDescendantById("task-output") as SelectRenderable).options.map((item) => item.name).join("\n")).not.toContain(secret);
    const cancel = await start("publish", "cancel", "pack cancel:cancel");
    await choose(ui, "app-ios"); await submitParameters(ui); await choose(ui, "yes"); await cancel.running;
    expect((await records()).at(-1)!.argv).toEqual(["pack", "cancel", "--project", project, "--platform", "app-ios"]);
    await saveProof("workflow-argv.jsonl", (await fs.readFile(record, "utf8")).replaceAll(secret, "<REDACTED>"));
    await fs.writeFile(helpFile, "HBuilderX changed fixture\nproject list\n  Projects\n");
    await app.perform("connect");
    const removed = app.perform("run"); await choose(ui, "app-android"); await choose(ui, "back");
    expect(choice(ui)!.options.some((option) => option.value === "app-android")).toBe(true);
    await escape(ui); await removed;
  } finally {
    if (app) await app.shutdown(); await ui.dispose();
    if (previous === undefined) delete process.env.LAZYHB_STATE_DIR; else process.env.LAZYHB_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("overview, config and split logs retain stable project navigation across resize and overlays", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lazyhb-navigation-")));
  const previous = process.env.LAZYHB_STATE_DIR;
  process.env.LAZYHB_STATE_DIR = join(root, "state");
  const ui = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
  let app: Workspace | undefined;
  try {
    for (const name of ["Preview A", "Preview B", "Preview C", "Preview D"]) {
      const project = join(root, name);
      await fs.mkdir(project); await fs.writeFile(join(project, "manifest.json"), '{"name":"Preview"}');
      await new ProjectRegistry().add(project);
    }
    app = new Workspace(ui.renderer, { cli: join(root, "no-cli") });
    await app.init();
    await settle(ui, () => (ui.renderer.root.findDescendantById("task-output") as SelectRenderable).options.some((item) => item.name.includes("不可执行")));
    const projects = ui.renderer.root.findDescendantById("projects")!;
    const pages = ui.renderer.root.findDescendantById("workspace-pages") as SelectRenderable;
    for (const [width, height] of [[120, 40], [100, 30], [64, 24]]) {
      ui.resize(width, height); ui.mockInput.pressKey("2"); await tick(ui);
      const projectHeight = projects.height;
      ui.mockInput.pressKey("3"); await tick(ui);
      expect(ui.renderer.root.findDescendantById("fields")!.focused).toBe(true);
      expect(projects.height).toBe(projectHeight);
      ui.mockInput.pressKey("?"); await tick(ui); await escape(ui);
      ui.mockInput.pressKey(","); await tick(ui); await escape(ui);
      expect(ui.renderer.root.findDescendantById("fields")!.focused).toBe(true);
      ui.mockInput.pressKey("4"); await tick(ui);
      expect(ui.renderer.root.findDescendantById("task-output")!.focused).toBe(true);
      expect(projects.height).toBe(projectHeight);
      expect(pages.getSelectedOption()?.value).toBe(2);
      expect(projects.visible).toBe(true);
      await saveProof(`workspace-pages-${width}x${height}.txt`, ui.captureCharFrame());
    }
  } finally {
    if (app) await app.shutdown(); await ui.dispose();
    if (previous === undefined) delete process.env.LAZYHB_STATE_DIR; else process.env.LAZYHB_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("live CLI tasks stay inspectable, stop from mouse and keys, and cancelled discovery never changes CLI", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lazyhb-stop-")));
  const previous = process.env.LAZYHB_STATE_DIR;
  process.env.LAZYHB_STATE_DIR = join(root, "state");
  const ui = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
  let app: Workspace | undefined;
  const alive = (pid: number) => {
    if (process.platform !== "win32") {
      const state = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
      // Only an actual zombie state proves an existing PID cannot execute.
      if (state.exitCode === 0 && /^Z\S*$/.test(state.stdout.toString().trim())) return false;
    }
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  const record = join(root, "tasks.jsonl"), pidsFile = join(root, "pids.jsonl"), helpRecord = join(root, "helps.txt");
  const allPids: number[] = [];
  try {
    const a = join(root, "Project A"), b = join(root, "Project B");
    for (const path of [a, b]) {
      await fs.mkdir(path); await fs.writeFile(join(path, "manifest.json"), '{"name":"Fixture","appid":"fixture"}');
      await new ProjectRegistry().add(path);
    }
    const cli = join(root, process.platform === "win32" ? "fixture.exe" : "fixture");
    const candidate = join(root, process.platform === "win32" ? "candidate.exe" : "candidate");
    const source = join(root, "fixture.ts");
    const help = "HBuilderX isolated stop fixture\nproject list\n  Projects\ndevices list\n  --platform  取值有[android]\nlaunch app-android\n  Watch fixture\n  --project  Project\n  --ui  取值有[false|true]\n  --compile  取值有[false|true]\n  --deviceId  Serial\n";
    await fs.writeFile(source, `import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
// Real process timers keep descendants alive for OS process-group cleanup; fake timers cannot exercise signals.
import {spawn} from 'node:child_process';
import {basename} from 'node:path';
const args=process.argv.slice(2), name=basename(process.execPath);
const record=${JSON.stringify(record)}, pids=${JSON.stringify(pidsFile)};
if(args.includes('--help')) {
 appendFileSync(${JSON.stringify(helpRecord)},name+'\\n');
 if(name.startsWith('candidate') && existsSync(${JSON.stringify(join(root, "hold-candidate"))})) {
  writeFileSync(${JSON.stringify(join(root, "candidate-ready"))},String(process.pid));
  process.on('SIGTERM',()=>{console.log(${JSON.stringify(help)});process.exit(0)});
  setInterval(()=>{},1000);
 } else console.log(${JSON.stringify(help)});
} else {
 const descendant=args[0]?.startsWith('tree-');
 const run=descendant?args[1]:String(Date.now());
 if(!descendant) appendFileSync(record,JSON.stringify({argv:args,run})+'\\n');
 appendFileSync(pids,JSON.stringify({pid:process.pid,run})+'\\n');
 process.on('SIGTERM',()=>{if(!descendant) process.exit(0)});
 if(args[0]!=='tree-grandchild') spawn(process.execPath,[descendant?'tree-grandchild':'tree-child',run],{shell:false,stdio:'ignore'});
 setInterval(()=>writeFileSync(${JSON.stringify(join(root, "heartbeat-"))}+process.pid,String(Date.now())),30);
 if(!descendant) console.log('fixture watch ready '+run);
}
`);
    const compilation = Bun.spawn([process.execPath, "build", source, "--compile", "--outfile", cli], { stdout: "ignore", stderr: "pipe" });
    expect(await compilation.exited).toBe(0);
    await fs.copyFile(cli, candidate);
    app = new Workspace(ui.renderer, { project: a, cli });
    await app.init();
    const control = ui.renderer.root.findDescendantById("task-control") as TextRenderable;
    const projects = ui.renderer.root.findDescendantById("projects") as SelectRenderable;
    const logs = ui.renderer.root.findDescendantById("task-output") as SelectRenderable;
    await settle(ui, () => logs.options.some((option) => option.name.includes("CLI 已连接")));
    const taskRecords = async () => (await fs.readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; run: string });
    const treeReady = async (minimumRecords = 0) => {
      await settle(ui, async () => {
        if (!(await fs.exists(pidsFile))) return false;
        const rows = (await fs.readFile(pidsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { pid: number; run: string });
        const records = await taskRecords();
        if (records.length < minimumRecords) return false;
        const latest = records.at(-1)!;
        const tree = rows.filter((row) => row.run === latest.run);
        if (tree.length < 3) return false;
        for (const row of tree) if (!allPids.includes(row.pid)) allPids.push(row.pid);
        return tree.every((row) => alive(row.pid));
      });
    };
    const start = async () => {
      const expected = (await fs.exists(record) ? (await taskRecords()).length : 0) + 1;
      ui.mockInput.pressKey("3"); await tick(ui);
      const running = app!.perform("run");
      await choose(ui, "app-android"); await choose(ui, "launch app-android:run"); await choose(ui, "first"); await choose(ui, "yes");
      await treeReady(expected);
      expect(control.visible).toBe(true);
      expect(ui.captureCharFrame()).toContain("Ctrl+K");
      return { running };
    };
    const first = await start(); await first.running;
    const firstPids = [...allPids];
    const tasks = ui.renderer.root.findDescendantById("task-records") as SelectRenderable;
    const firstId = tasks.getSelectedOption()!.value;
    const second = await start(); await second.running;
    const secondId = tasks.getSelectedOption()!.value;
    expect(secondId).not.toBe(firstId);
    expect(await taskRecords()).toHaveLength(2);
    expect(firstPids.every(alive)).toBe(true);
    expect(logs.focused).toBe(true);
    ui.mockInput.pressArrow("up", { meta: true }); await tick(ui);
    expect(tasks.getSelectedOption()!.value).toBe(firstId);
    expect(logs.focused).toBe(true);
    const firstOutput = await taskRecords();
    expect(logs.options.some((item) => item.name.includes(firstOutput[0].run))).toBe(true);
    expect(logs.options.some((item) => item.name.includes(firstOutput[1].run))).toBe(false);
    ui.mockInput.pressArrow("down", { meta: true }); await tick(ui);
    expect(tasks.getSelectedOption()!.value).toBe(secondId);
    expect(logs.focused).toBe(true);
    await app.perform("cli"); await app.perform("save"); expect(modal(ui)).toBeUndefined();
    ui.mockInput.pressKey("1"); await tick(ui);
    projects.setSelectedIndex(projects.options.findIndex((option) => option.value === b));
    ui.mockInput.pressEnter();
    await settle(ui, () => (ui.renderer.root.findDescendantById("workspace-title") as TextRenderable).plainText.includes(b));
    ui.mockInput.pressKey("3"); await tick(ui);
    expect(ui.renderer.root.findDescendantById("fields")!.focused).toBe(true);
    await app.perform("logs"); await tick(ui);
    tasks.setSelectedIndex(tasks.options.findIndex((item) => item.value === firstId)); await tick(ui);
    expect((ui.renderer.root.findDescendantById("selected-task-status") as TextRenderable).plainText).toContain(a);
    expect(logs.options.some((item) => item.name.includes("fixture watch ready"))).toBe(true);
    const recordsAtStart = await taskRecords();
    expect(logs.options.some((item) => item.name.includes(recordsAtStart[0].run))).toBe(true);
    expect(logs.options.some((item) => item.name.includes(recordsAtStart[1].run))).toBe(false);
    const before = logs.getSelectedIndex();
    ui.mockInput.pressKey("?"); await tick(ui); await escape(ui);
    expect(logs.getSelectedIndex()).toBe(before);
    ui.resize(64, 24); await tick(ui);
    ui.mockInput.pressKey("k", { ctrl: true });
    await settle(ui, () => tasks.options.some((item) => item.value === firstId && item.name.includes("已取消")));
    expect(firstPids.every((pid) => !alive(pid))).toBe(true);
    expect(allPids.filter((pid) => !firstPids.includes(pid)).every(alive)).toBe(true);
    expect(tasks.options.find((item) => item.value === secondId)!.name).toContain("运行中");
    tasks.setSelectedIndex(tasks.options.findIndex((item) => item.value === secondId)); await tick(ui);
    expect(logs.options.some((item) => item.name.includes(recordsAtStart[1].run))).toBe(true);
    expect(logs.options.some((item) => item.name.includes(recordsAtStart[0].run))).toBe(false);
    expect(logs.options.some((item) => item.name.includes("已取消"))).toBe(false);
    const stopButton = ui.renderer.root.findDescendantById("stop-selected-task")!;
    await ui.mockMouse.click(stopButton.x + 1, stopButton.y);
    await settle(ui, () => !control.visible);
    expect(allPids.every((pid) => !alive(pid))).toBe(true);
    expect(tasks.options.filter((item) => item.name.includes("已取消"))).toHaveLength(2);
    await saveProof("concurrent-task-history.txt", ui.captureCharFrame());
    // Stop while executable() is still awaiting filesystem lookup: no extra help process may be spawned.
    const helpsBefore = await fs.readFile(helpRecord, "utf8");
    const reconnect = app.perform("connect");
    await app.perform("stop"); await reconnect; await settle(ui, () => !control.visible);
    expect(await fs.readFile(helpRecord, "utf8")).toBe(helpsBefore);
    // Candidate emits a successful help on TERM; cancellation must still retain old CLI and unsaved input.
    await fs.writeFile(join(root, "hold-candidate"), "");
    const configuring = app.perform("cli"); await choose(ui, "@input");
    ui.mockInput.pressKey("a", { ctrl: true }); await ui.mockInput.typeText(candidate);
    ui.mockInput.pressKey("s", { ctrl: true });
    await settle(ui, () => fs.exists(join(root, "candidate-ready")));
    await ui.mockMouse.click(control.x + 2, control.y + 1);
    ui.mockInput.pressKey("k", { ctrl: true });
    await settle(ui, () => !control.visible);
    expect(modal(ui)).toBeDefined();
    expect(ui.captureCharFrame()).toContain("candidate");
    expect(await fs.exists(join(root, "state", "settings.json"))).toBe(false);
    await saveProof("candidate-cancel-retained-input.txt", ui.captureCharFrame());
    await escape(ui); await escape(ui); await configuring;
    const retained = await start();
    const helpsAfter = await fs.readFile(helpRecord, "utf8");
    expect(helpsAfter.trim().split("\n").filter((name) => name.startsWith("candidate"))).toHaveLength(1);
    await app.perform("stop"); await retained.running; await settle(ui, () => !control.visible);
    await saveProof("task-cancelled-and-recovered.txt", ui.captureCharFrame());
    const launchCount = (await taskRecords()).filter((item) => item.argv[0] === "launch").length;
    const query = app.perform("run");
    await choose(ui, "app-android"); await choose(ui, "launch app-android:run"); await choose(ui, "query");
    await treeReady();
    expect(control.visible).toBe(true);
    expect((ui.renderer.root.findDescendantById("workspace-status") as TextRenderable).plainText).toContain("devices list");
    await saveProof("devices-query-active.txt", ui.captureCharFrame());
    ui.mockInput.pressKey("k", { ctrl: true });
    await settle(ui, () => !!choice(ui) && !control.visible);
    expect(choice(ui)!.options.some((option) => option.value === "query")).toBe(true);
    expect((await taskRecords()).filter((item) => item.argv[0] === "launch")).toHaveLength(launchCount);
    await saveProof("devices-query-cancelled-retry.txt", ui.captureCharFrame());
    await escape(ui); await query;
    const exiting = await start();
    const exitingSecond = await start();
    ui.mockInput.pressKey("q"); await tick(ui); await choose(ui, "yes");
    await exiting.running; await exitingSecond.running; await ui.renderer.closed;
    expect(allPids.every((pid) => !alive(pid))).toBe(true);
    await fs.rm(join(root, "candidate-ready"));
    const closingUi = await createTestRenderer({ width: 64, height: 24, exitOnCtrlC: false });
    const closingApp = new Workspace(closingUi.renderer, { project: b, cli: candidate });
    try {
      await closingApp.init();
      await settle(closingUi, () => fs.exists(join(root, "candidate-ready")));
      const pid = Number(await fs.readFile(join(root, "candidate-ready"), "utf8"));
      allPids.push(pid); expect(alive(pid)).toBe(true);
      await closingApp.shutdown();
      expect(alive(pid)).toBe(false);
      expect(await fs.exists(join(root, "state", "settings.json"))).toBe(false);
    } finally { await closingApp.shutdown(); await closingUi.dispose(); }
  } finally {
    if (app) await app.shutdown(); await ui.dispose();
    for (const pid of allPids) if (alive(pid)) process.kill(pid, "SIGKILL");
    if (previous === undefined) delete process.env.LAZYHB_STATE_DIR; else process.env.LAZYHB_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60000);

test("pack preparation cancellation prevents submission and waits for private snapshot cleanup", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lazyhb-pack-cancel-")));
  const source = join(root, "fixture.ts"), record = join(root, "argv.json");
  const client = new HXClient(process.execPath, { argumentPrefix: [source] });
  try {
    const help = "HBuilderX isolated pack preparation fixture\nproject list\n  Projects\npack\n  --project  Project 必填\n  --config  JSON path\n  --platform  取值有[android|ios]\n";
    await fs.writeFile(source, `import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('--help')) console.log(${JSON.stringify(help)});
else writeFileSync(${JSON.stringify(record)},JSON.stringify({args,configuration:JSON.parse(readFileSync(args[args.indexOf('--config')+1],'utf8'))}));
`);
    await client.discover();
    const before = (await fs.readdir(tmpdir())).filter((name) => name.startsWith("lazyhb-pack-")).sort();
    const running = client.run("pack", { project: root, platform: "android" }, () => {});
    const outcome = running.then((code) => ({ code, error: undefined }), (error: unknown) => ({ code: undefined, error }));
    expect(client.running).toBe(true);
    const stopping = client.cancel();
    expect(client.cancel()).toBe(stopping);
    await stopping;
    expect((await outcome).error).toBeInstanceOf(CLICancelledError);
    expect(client.running).toBe(false);
    expect(await fs.exists(record)).toBe(false);
    expect((await fs.readdir(tmpdir())).filter((name) => name.startsWith("lazyhb-pack-")).sort()).toEqual(before);
    expect(await client.run("pack", { project: root, platform: "android" }, () => {})).toBe(0);
    const submitted = JSON.parse(await fs.readFile(record, "utf8")) as { args: string[]; configuration: { project: string } };
    expect(submitted.configuration.project).toBe(root);
    expect(await fs.exists(submitted.args[submitted.args.indexOf("--config") + 1])).toBe(false);
  } finally {
    await client.cancel();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("long confirmation keeps both decisions visible after resize and scroll while cancellation stays safe", async () => {
  const ui = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
  const dialogs = new Dialogs(ui.renderer, () => {});
  const handler = (key: Parameters<Dialogs["handleKey"]>[0]) => dialogs.handleKey(key);
  ui.renderer.keyInput.on("keypress", handler);
  const target = "/" + "项目Project路径/".repeat(25) + "TARGET-END";
  const summary = target + "\n" + "费用与资源边界说明 ".repeat(60) + "RISK-END";
  try {
    const canceled = dialogs.confirm(summary); await tick(ui);
    ui.resize(64, 24); await tick(ui);
    expect(ui.captureCharFrame()).toContain("取消 / 否");
    expect(ui.captureCharFrame()).toContain("确认 / 是");
    expect(choice(ui)!.getSelectedOption()!.value).toBe("no");
    await saveProof("confirmation-resize-120-to-64.txt", ui.captureCharFrame());
    ui.mockInput.pressTab(); ui.mockInput.pressKey("END"); await tick(ui);
    expect(ui.captureCharFrame()).toContain("RISK-END");
    expect(ui.captureCharFrame()).toContain("取消 / 否");
    expect(ui.captureCharFrame()).toContain("确认 / 是");
    await saveProof("confirmation-64x24-scroll-end.txt", ui.captureCharFrame());
    ui.mockInput.pressKey("HOME"); await tick(ui);
    for (let page = 0; page < 3 && !ui.captureCharFrame().includes("TARGET-END"); page++) {
      ui.mockInput.pressKey("\u001b[6~"); await tick(ui);
    }
    expect(ui.captureCharFrame()).toContain("TARGET-END");
    await saveProof("confirmation-64x24-target.txt", ui.captureCharFrame());
    await escape(ui); expect(await canceled).toBe(false);
    const defaultNo = dialogs.confirm(summary); await tick(ui);
    ui.mockInput.pressEnter(); expect(await defaultNo).toBe(false);
    const mouseNo = dialogs.confirm(summary); await tick(ui);
    ui.mockInput.pressArrow("down"); await tick(ui);
    expect(choice(ui)!.getSelectedOption()!.value).toBe("yes");
    const noRow = ui.captureCharFrame().split("\n").findIndex((line) => line.includes("取消 / 否"));
    expect(noRow).toBeGreaterThanOrEqual(0);
    await ui.mockMouse.click(choice(ui)!.x + 4, noRow); await tick(ui);
    expect(choice(ui)!.getSelectedOption()!.value).toBe("no");
    await saveProof("confirmation-mouse-no-after-yes.txt", ui.captureCharFrame());
    ui.mockInput.pressEnter(); expect(await mouseNo).toBe(false);
    const many = dialogs.choice("滚动候选", Array.from({ length: 30 }, (_, index) => ({ value: String(index), label: `候选 ${index}` })));
    await tick(ui);
    for (let at = 0; at < 24; at++) ui.mockInput.pressArrow("down");
    await tick(ui);
    const list = choice(ui)!;
    const visible = /候选 (\d+)/.exec(ui.captureCharFrame().split("\n")[list.y])?.[1];
    expect(visible).toBeDefined(); expect(visible).not.toBe("0");
    await ui.mockMouse.click(list.x + 4, list.y); await tick(ui);
    ui.mockInput.pressEnter(); expect(await many).toBe(visible);
  } finally {
    dialogs.cancelActive(); ui.renderer.keyInput.off("keypress", handler); await ui.dispose();
  }
});
