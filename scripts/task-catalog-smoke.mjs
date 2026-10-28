import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HXClient } from "../dist/hx.js";
import { taskChoices, taskMode } from "../dist/task-catalog.js";

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
    ["launch web", [["ui", "true|false"], ["compile", "true|false"], ["projectPath"]]],
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
  assert.equal(choice("launch web").mode, "compile");
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
  const web = choice("launch web");
  assert.equal(await client.run(web.command, { ...web.defaults, [web.projectParameter]: target }, () => {}), 0);
  assert.deepEqual(JSON.parse(await fs.readFile(record, "utf8")), ["launch", "web", "--ui", "false", "--compile", "true", "--projectPath", target]);
  await fs.writeFile(helpFile, entry("launch app-ios", [["ui", "0"], ["iosTarget", "device|simulator"], ["project"]]));
  const revised = taskChoices(await client.discover(), "run");
  assert.equal(revised.length, 1, "refresh uses current CLI rather than stale candidates");
  assert.equal(revised[0].defaults.iosTarget, "device");
  client.arguments(revised[0].command, revised[0].defaults);
  assert.throws(() => client.arguments(revised[0].command, { ui: "0", iosTarget: "simulator" }));
  await fs.writeFile(helpFile, entry("launch web", [["ui", "true"], ["compile", "true"]]));
  assert.ok(taskChoices(await client.discover(), "run").every((choice) => choice.unavailable));
  console.log("PASS discovered task families, legal enum defaults, compile/run distinction, explicit project binding and executable argv");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
