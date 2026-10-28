import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HXClient } from "../dist/hx.js";
import { taskChoices, taskParameters, validateTask } from "../dist/task-catalog.js";

// Protocol fixture excerpts model observed help, not a claim of native publishing.
const root = await fs.mkdtemp(join(tmpdir(), "lazyhb-workflow-consumer-"));
try {
  const help = join(root, "help.txt"), record = join(root, "argv.jsonl");
  const executable = join(root, "cli.mjs"), project = join(root, "Project B");
  await fs.mkdir(project);
  await fs.writeFile(executable, `import {readFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('--help')) process.stdout.write(readFileSync(${JSON.stringify(help)},'utf8'));
else appendFileSync(${JSON.stringify(record)},JSON.stringify(args)+'\\n');
`);
  const client = new HXClient(process.execPath, { argumentPrefix: [executable] });
  const discover = async (text) => {
    await fs.writeFile(help, `HBuilderX isolated workflow protocol\nproject list\n  List imported projects\n${text}`);
    return client.discover();
  };
  const entry = (name, parameters) => `${name}\n  Workflow fixture\n${parameters.map(([key, description]) => `  --${key}  ${description}`).join("\n")}\n`;
  const selector = ["project", "项目绝对路径"];
  const send = async (choice, extra = {}) => {
    assert.ok(choice && !choice.unavailable, "requested workflow must be executable");
    const values = { ...choice.defaults, project, ...extra };
    validateTask(choice, values);
    client.arguments(choice.command, values, true);
    assert.equal(await client.run(choice.command, values, () => {}, { allowSensitive: true }), 0);
    const lines = (await fs.readFile(record, "utf8")).trim().split("\n");
    return JSON.parse(lines.at(-1));
  };
  const value = (argv, key) => argv[argv.indexOf(`--${key}`) + 1];
  let commands = await discover(
    entry("publish app-android", [selector, ["type", "本地打包类型，固定为 appResource，用于生成本地打包 App 资源"]]) +
    entry("publish app-android", [selector, ["type", "打包类型，固定为 wgt，用于制作应用 wgt 包"], ["path", "导出路径"]]) +
    entry("pack status", [selector]) + entry("pack cancel", [selector, ["platform", "取值有[app-ios|app-android]"]]),
  );
  let choices = taskChoices(commands, "publish", "uni-app");
  for (const type of ["appResource", "wgt"]) {
    const args = await send(choices.find(c => c.defaults.type === type), type === "wgt" ? { path: join(root, "output") } : {});
    assert.equal(value(args, "type"), type);
    assert.equal(value(args, "project"), project);
    if (type === "wgt") assert.equal(value(args, "path"), join(root, "output"));
  }
  const xWgt = taskChoices(commands, "publish", "uni-app-x").find(c => c.defaults.type === "wgt");
  assert.equal(value(await send(xWgt), "type"), "wgt", "uni-app x can still export WGT");
  for (const operation of ["status", "cancel"]) {
    const args = await send(choices.find(c => c.command.name === `pack ${operation}`), operation === "cancel" ? { platform: "app-ios" } : {});
    assert.equal(value(args, "project"), project);
    assert.deepEqual(args.slice(0, 2), ["pack", operation]);
    assert.ok(!args.includes("--taskId"));
    if (operation === "cancel") assert.equal(value(args, "platform"), "app-ios");
  }
  commands = await discover(entry("publish mp-weixin", [selector, ["upload", "取值有[true|false]"], ["subPackage", "与 upload 互斥"], ["appid", "应用ID"], ["privatekey", "上传密钥文件"]]));
  choices = taskChoices(commands, "publish", "uni-app");
  const upload = choices.find(c => c.defaults.upload === "true");
  assert.throws(() => validateTask(upload, { ...upload.defaults, project, appid: "fixture", privatekey: "/fixture.key", subPackage: "mixed" }));
  assert.throws(() => validateTask(upload, { ...upload.defaults, project }));
  const uploaded = await send(upload, { appid: "fixture", privatekey: "/fixture.key" });
  assert.equal(value(uploaded, "upload"), "true");
  assert.ok(!uploaded.includes("--onlycompile"));
  commands = await discover(entry("publish web", [selector, ["webHosting", "取值有[true]"], ["provider", "取值有[aliyun]"], ["spaceId", "空间ID"], ["futureRequired", "必填，未来版本上下文"]]));
  choices = taskChoices(commands, "publish");
  assert.ok(choices.some(c => !c.unavailable), "supported hosting workflow remains reachable");
  for (const choice of choices.filter(c => !c.unavailable)) {
    const values = { ...choice.defaults, project, provider: "aliyun", spaceId: "fixture" };
    assert.ok(taskParameters(choice, values).some(p => p.name === "futureRequired"), "unknown required input remains fillable");
    assert.throws(() => client.arguments(choice.command, values, true));
    const args = await send(choice, { provider: "aliyun", spaceId: "fixture", futureRequired: "context" });
    assert.equal(value(args, "webHosting"), "true", "unsupported false mode cannot execute");
  }
  // A synthetic legacy help version, not execution against a historical HBuilderX.
  commands = await discover(entry("publish", [selector, ["platform", "取值有[APP|H5|MP-WEIXIN]"], ["type", "必填，取值有[appResource|wgt]"], ["upload", "取值有[true|false]"], ["webHosting", "取值有[true|false]"]]));
  choices = taskChoices(commands, "publish");
  for (const platform of ["APP", "H5", "MP-WEIXIN"]) {
    const choice = choices.find(c => !c.unavailable && c.defaults.platform === platform && c.defaults.upload !== "true" && c.defaults.webHosting !== "true");
    const args = await send(choice);
    assert.equal(args[0], "publish");
    assert.equal(value(args, "platform"), platform);
    assert.ok(!args.includes("--onlycompile"));
  }
  assert.throws(() => client.arguments("publish", { project, platform: "APP" }));
  commands = await discover(
    entry("publish mp-alipay", [selector]) +
    entry("pack mp-harmony", [selector]) +
    entry("launch quickapp-webview-huawei", [selector, ["ui", "取值有[true|false]"], ["compile", "取值有[true|false]"]]),
  );
  const xRestricted = [...taskChoices(commands, "publish", "uni-app-x"), ...taskChoices(commands, "run", "uni-app-x")];
  for (const name of ["publish mp-alipay", "pack mp-harmony", "launch quickapp-webview-huawei"]) {
    const visible = xRestricted.filter(c => c.command.name === name);
    assert.ok(visible.length && visible.every(c => c.unavailable), "unsupported x target stays visible but not executable");
  }
  commands = await discover(entry("publish", [selector, ["platform", "发行平台"]]));
  assert.ok(taskChoices(commands, "publish").every(c => c.unavailable), "unverified legacy platform cannot execute guessed target");
  commands = await discover(entry("launch web", [selector, ["ui", "取值有[true]"], ["compile", "取值有[true|false]"]]));
  assert.ok(taskChoices(commands, "run").every(c => c.unavailable), "capability refresh cannot retain prior runnable mode");
  assert.throws(() => client.arguments("publish app-android", { project, type: "wgt" }));
  console.log("PASS workflow consumer: duplicate artifact modes, real argv, project-bound management, upload conditions, required fields and capability refresh including legacy help");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
