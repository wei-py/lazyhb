import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HXClient } from "../dist/hx.js";
import { taskChoices, taskMode, taskParameters, validateTask } from "../dist/task-catalog.js";

const root = await fs.mkdtemp(join(tmpdir(), "lazyhb-task-catalog-"));
try {
  const record = join(root, "argv.json");
  const helpFile = join(root, "help.txt");
  const executable = join(root, "fixture.mjs");
  await fs.writeFile(executable, `import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('--help')) console.log('HBuilderX isolated fixture\\nproject list\\n  List projects\\n'+readFileSync(${JSON.stringify(helpFile)},'utf8'));
else writeFileSync(${JSON.stringify(record)},JSON.stringify(args));\n`);
  const entry = (name, parameters = []) => `${name}\n  Fixture capability\n${parameters.map(([name, choices]) => `  --${name}  ${choices ? `取值有[${choices}]` : "Project selector"}`).join("\n")}\n`;
  const cases = [
    ["launch web", [["ui", "true|false"], ["compile", "true|false"], ["browser", "Built|Chrome|Firefox"], ["projectPath"]]],
    ["launch mp-future", [["ui", "0|1"], ["compile", "true"], ["prj"]]],
    ["launch quickapp-future", [["ui", "false"], ["compile", "false"]]],
    ["launch mp-no-ui", [["compile", "true"]]],
    ["launch mp-no-compile", [["ui", "false"]]],
    ["launch app-android", [["ui", "false"], ["compile", "true"], ["project"]]],
    ["launch app-harmony", [["ui", "false"], ["compile", "true|false"], ["project"]]],
    ["launch app-ios", [["ui", "false"], ["iosTarget", "simulator"]]],
    ["launch unknown", [["ui", "false"], ["compile", "true"]]],
    ["launch mp-gui", [["ui", "true"], ["compile", "true"]]],
    ["launch mp-numeric", [["ui", "0"], ["compile", "0|1"]]],
    ["publish web", [["project"]]], ["publish future", [["path"]]],
    ["pack", [["project"]]], ["pack app-harmony", [["prj"]]],
    ["pack mp-harmony", [["projectPath"]]], ["pack status"], ["pack cancel"],
    ["pack future"], ["publish future nested"], ["cloud functions"], ["hosting deploy"],
  ];
  await fs.writeFile(helpFile, cases.map(([name, params]) => entry(name, params)).join("\n"));
  const client = new HXClient(process.execPath, { argumentPrefix: [executable] });
  const commands = await client.discover();
  const runs = taskChoices(commands, "run").filter((choice) => !choice.unavailable);
  assert.deepEqual(new Set(runs.map(({ command }) => command.name)), new Set([
    "launch web", "launch mp-future", "launch app-android", "launch app-harmony", "launch unknown",
  ]));
  const choice = (name, mode) => runs.find((item) => item.command.name === name && (!mode || item.mode === mode));
  assert.equal(choice("launch web", "run").id, "launch web:run");
  assert.equal(choice("launch web", "run").defaults.compile, "false");
  assert.equal(choice("launch web", "compile").defaults.compile, "true");
  assert.equal(taskMode(choice("launch web", "run"), { compile: "false" }), "run");
  assert.equal(taskMode(choice("launch web", "compile"), { compile: "true" }), "compile");
  assert.ok(taskParameters(choice("launch web", "run"), {}).some((parameter) => parameter.name === "browser"));
  assert.ok(taskParameters(choice("launch web", "compile"), {}).every((parameter) => parameter.name !== "browser"));
  assert.ok(taskParameters(choice("launch web", "run"), {}).every((parameter) => parameter.name !== "port"), "port is project configuration, not a CLI parameter");
  assert.throws(() => validateTask(choice("launch web", "run"), { ui: "false", compile: "true" }));
  assert.throws(() => validateTask(choice("launch web", "run"), { ui: "false", compile: "false", browser: "Unknown" }));
  assert.equal(choice("launch app-android").mode, "compile");
  assert.equal(taskMode(choice("launch app-android"), {}), "compile");
  assert.equal(taskMode(choice("launch app-android"), { compile: "" }), "compile");
  assert.equal(choice("launch app-harmony", "run").mode, "run");
  assert.equal(taskMode(choice("launch app-harmony", "compile"), { compile: "true" }), "compile");
  assert.equal(taskMode(choice("launch app-harmony", "run"), { compile: "false" }), "run");
  assert.equal(choice("launch mp-future").defaults.ui, "0");
  const publish = taskChoices(commands, "publish");
  assert.deepEqual(new Set(publish.map(({ command }) => command.name)), new Set([
    "publish web", "publish future", "pack", "pack app-harmony", "pack mp-harmony", "pack status", "pack cancel",
  ]));
  for (const name of ["pack status", "pack cancel"]) assert.equal(publish.find((item) => item.command.name === name).mode, "manage");
  assert.equal(publish.find((item) => item.command.name === "publish future").projectParameter, undefined, "output path is not project binding");
  const target = join(root, "Project B");
  await fs.mkdir(target);
  for (const mode of ["run", "compile"]) {
    const web = choice("launch web", mode);
    const values = { ...web.defaults, ...(mode === "run" ? { browser: "Chrome" } : {}), [web.projectParameter]: target };
    validateTask(web, values);
    assert.equal(await client.run(web.command, values, () => {}), 0);
    assert.deepEqual(JSON.parse(await fs.readFile(record, "utf8")), [
      "launch", "web", "--ui", "false", "--compile", mode === "run" ? "false" : "true",
      ...(mode === "run" ? ["--browser", "Chrome"] : []), "--projectPath", target,
    ]);
  }
  assert.throws(() => client.arguments("launch web", { ui: "false" }), /compile/);
  assert.throws(() => client.arguments("launch web", { compile: "false" }), /ui/);
  assert.throws(() => client.arguments("launch mp-future", { ui: "0", compile: "false" }));
  assert.throws(() => client.arguments("launch quickapp-future", { ui: "false", compile: "false" }), /仅编译/);
  await fs.writeFile(helpFile, entry("launch app-ios", [["ui", "0"], ["iosTarget", "device|simulator"], ["project"]]));
  const revised = taskChoices(await client.discover(), "run");
  assert.equal(revised.length, 1, "refresh uses current CLI rather than stale candidates");
  assert.equal(revised[0].defaults.iosTarget, "device");
  client.arguments(revised[0].command, revised[0].defaults);
  assert.throws(() => client.arguments(revised[0].command, { ui: "0", iosTarget: "simulator" }));
  await fs.writeFile(helpFile, entry("launch web", [["ui", "true"], ["compile", "true"]]));
  assert.ok(taskChoices(await client.discover(), "run").every((choice) => choice.unavailable));
  for (const parameters of [
    [["ui", "false"], ["compile", "true"]],
    [["ui", "0"], ["compile", "true"]],
    [["ui", "false"], ["compile"]],
    [["ui", "false"], ["compile", "0|1"]],
    [["ui", "false"]],
    [["ui"], ["compile", "true|false"]],
    [["compile", "true|false"]],
  ]) {
    await fs.writeFile(helpFile, entry("launch web", parameters));
    const current = taskChoices(await client.discover(), "run");
    assert.ok(current.some((choice) => choice.id === "launch web:run" && choice.unavailable));
    assert.ok(current.every((choice) => choice.mode !== "run" || choice.unavailable), "unknown and compile-only help never promise Web runtime");
    assert.throws(() => client.arguments("launch web", { ui: "false", compile: "false" }));
    assert.throws(() => client.arguments("launch web", { ui: "false" }));
    const compile = current.find((choice) => choice.mode === "compile" && !choice.unavailable);
    if (compile) {
      assert.equal(await client.run(compile.command, compile.defaults, () => {}), 0);
      assert.deepEqual(JSON.parse(await fs.readFile(record, "utf8")), ["launch", "web", "--ui", compile.defaults.ui, "--compile", "true"]);
    }
  }
  await fs.writeFile(helpFile, entry("launch web", [["ui", "0"], ["compile", "false"], ["browser", "Firefox"]]));
  const restored = taskChoices(await client.discover(), "run").find((choice) => !choice.unavailable);
  assert.equal(restored.id, "launch web:run");
  assert.deepEqual(restored.defaults, { ui: "0", compile: "false" });
  assert.deepEqual(taskParameters(restored, {}).find((parameter) => parameter.name === "browser").choices, ["Firefox"]);
  assert.equal(await client.run(restored.command, { ...restored.defaults, browser: "Firefox" }, () => {}), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(record, "utf8")), ["launch", "web", "--ui", "0", "--compile", "false", "--browser", "Firefox"]);
  console.log("PASS discovered task families, legal enum defaults, executable Web run/compile argv, browser choices, explicit project binding and capability refresh");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
