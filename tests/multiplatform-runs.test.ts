import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SelectRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { Workspace } from "../src/app.js";
import { ProjectRegistry } from "../src/projects.js";

const tick = async (ui: TestRendererSetup) => { await ui.renderOnce(); await ui.flush(); };
const eventually = async (predicate: () => boolean | Promise<boolean>, description: string, ui?: TestRendererSetup) => {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (ui) await tick(ui);
    if (await predicate()) return;
    // Independent OS processes and HTTP listeners cannot advance under fake timers.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
  throw new Error(`Timed out waiting for ${description}${ui ? "\n" + ui.captureCharFrame() : ""}`);
};
const modal = (ui: TestRendererSetup) => ui.renderer.root.getChildren().find((node) => node !== ui.renderer.root.findDescendantById("workspace"));
const choice = (ui: TestRendererSetup) => modal(ui)?.getChildren().find((node) => node.visible && node.id !== "form-enum" && "getSelectedOption" in node) as SelectRenderable | undefined;
const choose = async (ui: TestRendererSetup, value: string) => {
  await eventually(() => !!choice(ui), `choice ${value}`, ui);
  const list = choice(ui)!;
  const index = list.options.findIndex((option) => option.value === value);
  expect(index).toBeGreaterThanOrEqual(0);
  for (let at = list.getSelectedIndex(); at < index; at++) ui.mockInput.pressArrow("down");
  for (let at = list.getSelectedIndex(); at > index; at--) ui.mockInput.pressArrow("up");
  ui.mockInput.pressEnter(); await tick(ui);
};
const modalText = (ui: TestRendererSetup) => {
  const nodes = [...(modal(ui)?.getChildren() ?? [])], text: string[] = [];
  while (nodes.length) {
    const node = nodes.pop()!;
    if ("plainText" in node) text.push(String(node.plainText));
    nodes.push(...node.getChildren());
  }
  return text.join("\n");
};
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
};

interface Startup {
  startupId: string;
  pid: number;
  argv: string[];
  project: string;
  port?: number;
  browser?: string;
  deviceId?: string;
}
interface Target {
  platform: "web" | "app-android" | "app-ios";
  project: string;
  browser?: "Chrome" | "Firefox";
  port?: number;
  deviceId?: string;
}

// These are real disposable CLI processes, HTTP listeners and OS signals, not
// HBuilderX runtimes or device deployment evidence. No connected hardware is used.
test("six guided Web, Android and physical-iOS fixture runs retain independent targets, output and lifetimes", async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "lazyhb-multiplatform-")));
  const previous = process.env.LAZYHB_STATE_DIR;
  process.env.LAZYHB_STATE_DIR = join(root, "state");
  const ui = await createTestRenderer({ width: 140, height: 44, exitOnCtrlC: false });
  let app: Workspace | undefined;
  const record = join(root, "startups.jsonl");
  const readStartups = async (): Promise<Startup[]> => await fs.exists(record)
    ? (await fs.readFile(record, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  // Reserve distinct OS-assigned ports until each confirmed launch needs it.
  const reservations = [Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") }),
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })];
  try {
    const firstProject = join(root, "Web A 项目"), secondProject = join(root, "Web B Project");
    for (const [index, project] of [firstProject, secondProject].entries()) {
      await fs.mkdir(project);
      await fs.writeFile(join(project, "manifest.json"), JSON.stringify({
        name: `Fixture ${index + 1}`, appid: `fixture-${index + 1}`, h5: { devServer: { port: reservations[index].port } },
      }));
      await new ProjectRegistry().add(project);
    }
    const cli = join(root, process.platform === "win32" ? "fixture-cli.exe" : "fixture-cli");
    const source = join(root, "fixture.ts");
    const help = `HBuilderX isolated multiplatform fixture
project list
  List projects
devices list
  --platform  取值有[android|ios-iPhone]
launch web
  --project  Project
  --ui  取值有[true|false]
  --compile  取值有[true|false]
  --browser  取值有[Built|Chrome|Firefox|Ie|Edge|Safari]
launch app-android
  --project  Project
  --ui  取值有[true|false]
  --compile  取值有[true|false]
  --deviceId  Serial
launch app-ios
  --project  Project
  --ui  取值有[true|false]
  --compile  取值有[true|false]
  --deviceId  Serial
  --iosTarget  取值有[device|simulator]
`;
    await fs.writeFile(source, `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const argv=process.argv.slice(2);
const flag=(name)=>{const at=argv.indexOf('--'+name);return at<0?undefined:argv[at+1]};
if(argv.includes('--help')) console.log(${JSON.stringify(help)});
else if(argv[0]==='version') console.log('fixture-5.24');
else if(argv[0]==='project') console.log('0:project list:OK');
else if(argv[0]==='devices') {
 const platform=flag('platform');
 if(platform==='android') console.log('android-usb-A: USB Android A\\nandroid-usb-B: USB Android B');
 else if(platform==='ios-iPhone') console.log('ios-physical-A: USB iPhone A\\nios-physical-B: USB iPhone B');
 else throw new Error('Unsupported device platform');
} else {
 if(argv[0]!=='launch'||!['web','app-android','app-ios'].includes(argv[1])) throw new Error('Unexpected fixture command');
 if(flag('ui')!=='false'||flag('compile')!=='false') throw new Error('Fixture requires headless real-run mode');
 const project=flag('project');
 if(!project) throw new Error('Explicit project required');
 const manifest=JSON.parse(readFileSync(join(project,'manifest.json'),'utf8'));
 const startupId=randomUUID(), deviceId=flag('deviceId'), browser=flag('browser');
 let server;
 const port=argv[1]==='web'?Number(manifest.h5.devServer.port):undefined;
 if(argv[1]==='web') {
  if(!['Chrome','Firefox'].includes(browser)) throw new Error('Explicit external browser required');
  server=Bun.serve({hostname:'127.0.0.1',port,fetch:()=>Response.json({startupId,project,browser,port})});
 } else {
  const allowed=argv[1]==='app-android'?['android-usb-A','android-usb-B']:['ios-physical-A','ios-physical-B'];
  if(!allowed.includes(deviceId)) throw new Error('Explicit fixture device required');
  if(argv[1]==='app-ios'&&flag('iosTarget')!=='device') throw new Error('Only physical iOS devices authorized');
 }
 appendFileSync(${JSON.stringify(record)},JSON.stringify({startupId,pid:process.pid,argv,project,port,browser,deviceId})+'\\n');
 console.log('fixture-start:'+startupId);
 let sequence=0;
 const beat=()=>{writeFileSync(join(${JSON.stringify(root)},'heartbeat-'+startupId),String(++sequence));console.log('fixture-heartbeat:'+startupId+':'+sequence)};
 beat();
 const timer=setInterval(beat,40);
 const stop=()=>{clearInterval(timer);server?.stop(true);process.exit(0)};
 process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
`);
    const compilation = Bun.spawn([process.execPath, "build", source, "--compile", "--outfile", cli], { stdout: "ignore", stderr: "pipe" });
    expect(await compilation.exited).toBe(0);
    app = new Workspace(ui.renderer, { project: firstProject, cli });
    await app.init();
    const tasks = ui.renderer.root.findDescendantById("task-records") as SelectRenderable;
    const logs = ui.renderer.root.findDescendantById("task-output") as SelectRenderable;
    const status = ui.renderer.root.findDescendantById("selected-task-status") as TextRenderable;
    await eventually(() => logs.options.some((option) => option.name.includes("CLI 已连接")), "fixture CLI connection", ui);
    const targets: Target[] = [
      { platform: "web", project: firstProject, browser: "Chrome", port: reservations[0].port },
      { platform: "web", project: secondProject, browser: "Firefox", port: reservations[1].port },
      { platform: "app-android", project: firstProject, deviceId: "android-usb-A" },
      { platform: "app-android", project: firstProject, deviceId: "android-usb-B" },
      { platform: "app-ios", project: secondProject, deviceId: "ios-physical-A" },
      { platform: "app-ios", project: secondProject, deviceId: "ios-physical-B" },
    ];
    const taskIds: number[] = [];
    for (const [index, target] of targets.entries()) {
      const running = app.perform("run", target.project);
      await choose(ui, target.platform);
      await choose(ui, `launch ${target.platform}:run`);
      if (target.browser) {
        await eventually(() => !!choice(ui), "browser controls", ui);
        expect(choice(ui)!.getSelectedOption()?.value).toBe("Chrome");
        expect(choice(ui)!.options.some((option) => option.value === "Built")).toBe(true);
        await choose(ui, target.browser);
      } else {
        if (index === 2 || index === 4) {
          await choose(ui, "query");
          await eventually(() => !!choice(ui) && modalText(ui).includes(target.deviceId!), "device query result", ui);
        }
        await choose(ui, "manual");
        await ui.mockInput.typeText(target.deviceId!);
        ui.mockInput.pressKey("s", { ctrl: true }); await tick(ui);
      }
      await eventually(() => !!choice(ui) && choice(ui)!.options.some((option) => option.value === "yes"), "run confirmation", ui);
      const confirmation = modalText(ui);
      expect(confirmation).toContain(target.project);
      expect(confirmation).toContain(target.browser ?? target.deviceId!);
      if (target.port) expect(confirmation).toContain(String(target.port));
      // Reserving ends immediately before the fixture takes ownership of its port.
      if (index < 2) reservations[index].stop(true);
      await choose(ui, "yes"); await running;
      await eventually(async () => (await readStartups()).length === index + 1, `launch ${index + 1} startup`, ui);
      taskIds.push(tasks.getSelectedOption()!.value as number);
      expect(tasks.getSelectedOption()!.name).toContain("运行中");
    }

    const startups = await readStartups();
    expect(startups).toHaveLength(6);
    expect(new Set(startups.map((item) => item.pid)).size).toBe(6);
    expect(new Set(startups.map((item) => item.startupId)).size).toBe(6);
    expect(new Set(taskIds).size).toBe(6);
    expect(startups.every((item) => alive(item.pid))).toBe(true);
    expect(tasks.options.filter((option) => option.name.includes("运行中"))).toHaveLength(6);
    for (const [index, startup] of startups.entries()) {
      const target = targets[index];
      const flag = (name: string) => startup.argv[startup.argv.indexOf(`--${name}`) + 1];
      expect(startup.argv.slice(0, 2)).toEqual(["launch", target.platform]);
      expect(flag("project")).toBe(target.project);
      expect(flag("ui")).toBe("false");
      expect(flag("compile")).toBe("false");
      expect(startup.argv).not.toContain("--port");
      if (target.browser) {
        expect(flag("browser")).toBe(target.browser);
        expect(startup.port).toBe(target.port);
      } else {
        expect(flag("deviceId")).toBe(target.deviceId);
        if (target.platform === "app-ios") expect(flag("iosTarget")).toBe("device");
      }
      tasks.setSelectedIndex(tasks.options.findIndex((option) => option.value === taskIds[index])); await tick(ui);
      expect(status.plainText).toContain(target.project);
      expect(status.plainText).toContain(target.browser ?? target.deviceId!);
      if (target.port) expect(status.plainText).toContain(String(target.port));
      await eventually(() => logs.options.some((option) => option.name.includes(`fixture-heartbeat:${startup.startupId}:`)), "selected independent output", ui);
      for (const other of startups) {
        if (other !== startup) expect(logs.options.some((option) => option.name.includes(other.startupId))).toBe(false);
      }
    }
    const response = async (startup: Startup) => {
      const result = await fetch(`http://127.0.0.1:${startup.port}/`, { signal: AbortSignal.timeout(500) });
      expect(result.ok).toBe(true);
      return await result.json();
    };
    for (const startup of startups.slice(0, 2)) {
      expect(await response(startup)).toEqual({ startupId: startup.startupId, project: startup.project, browser: startup.browser, port: startup.port });
    }
    const heartbeat = (startup: Startup) => fs.readFile(join(root, `heartbeat-${startup.startupId}`), "utf8");
    const before = await Promise.all(startups.map(heartbeat));
    await eventually(async () => (await Promise.all(startups.map(heartbeat))).every((value, index) => Number(value) > Number(before[index])), "all six concurrent heartbeats", ui);

    await ui.mockMouse.click(tasks.x + 2, tasks.y + 2); await tick(ui);
    expect(tasks.getSelectedOption()?.value).toBe(taskIds[0]);
    ui.mockInput.pressKey("k", { ctrl: true });
    await eventually(() => tasks.options.some((option) => option.value === taskIds[0] && option.name.includes("已取消")), "only selected Web cancellation", ui);
    await eventually(() => !alive(startups[0].pid), "selected process exit", ui);
    expect(startups.slice(1).every((startup) => alive(startup.pid))).toBe(true);
    expect(tasks.options.filter((option) => option.name.includes("运行中"))).toHaveLength(5);
    await eventually(async () => {
      try { await fetch(`http://127.0.0.1:${startups[0].port}/`, { signal: AbortSignal.timeout(500) }); return false; }
      catch { return true; }
    }, "cancelled Web listener close", ui);
    expect(await response(startups[1])).toEqual({ startupId: startups[1].startupId, project: secondProject, browser: "Firefox", port: startups[1].port });
    const survivors = startups.slice(1), survivorBefore = await Promise.all(survivors.map(heartbeat));
    await eventually(async () => (await Promise.all(survivors.map(heartbeat))).every((value, index) => Number(value) > Number(survivorBefore[index])), "five surviving independent heartbeats", ui);

    // Workspace shutdown exercises its public stopAll boundary, without reaching
    // into its private runner or replacing cancellation with fixture release flags.
    await app.shutdown(); app = undefined;
    await eventually(() => startups.every((startup) => !alive(startup.pid)), "all remaining fixture processes stopped");
    const finalHeartbeats = await Promise.all(startups.map(heartbeat));
    // A real quiet interval detects escaped fixture timers; fake time cannot
    // schedule writes in an independently executing native process.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 120);
    await promise;
    expect(await Promise.all(startups.map(heartbeat))).toEqual(finalHeartbeats);
    for (const startup of startups.slice(0, 2)) {
      let reachable = false;
      try { await fetch(`http://127.0.0.1:${startup.port}/`, { signal: AbortSignal.timeout(500) }); reachable = true; }
      catch { /* A stopped listener must reject a fresh request. */ }
      expect(reachable).toBe(false);
    }
  } finally {
    try {
      if (app) await app.shutdown();
    } finally {
      // Failure-only fallback is restricted to PIDs published by this fixture.
      for (const startup of await readStartups()) {
        if (alive(startup.pid)) {
          try { process.kill(startup.pid, "SIGKILL"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
      }
      for (const reservation of reservations) reservation.stop(true);
      await ui.dispose();
      if (previous === undefined) delete process.env.LAZYHB_STATE_DIR; else process.env.LAZYHB_STATE_DIR = previous;
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}, 60000);
