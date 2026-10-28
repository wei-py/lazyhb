import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestRenderer } from "@opentui/core/testing";
import { JsonDocument } from "../dist/config.js";
import { ProjectRegistry } from "../dist/projects.js";
import { Workspace } from "../dist/app.js";
import { Dialogs } from "../dist/dialogs.js";
const root = await fs.mkdtemp(join(tmpdir(), "lazyhb-ui-"));
const previous = process.env.LAZYHB_STATE_DIR;
process.env.LAZYHB_STATE_DIR = join(root, "state");
let setup;
let app;
try {
  const project = join(root, "project");
  await fs.mkdir(project);
  const manifest = join(project, "manifest.json");
  await fs.writeFile(
    manifest,
    '{\n // keep this comment\n name: "before",\n}\n',
  );
  await new ProjectRegistry().add(project);
  setup = await createTestRenderer({
    width: 132,
    height: 44,
    exitOnCtrlC: false,
  });
  app = new Workspace(setup.renderer, { project, cli: join(root, "no-cli") });
  await app.init();
  await setup.renderOnce();
  const tick = async () => {
    await Bun.sleep(20);
    await setup.flush();
  };
  setup.mockInput.pressKey("3");
  setup.mockInput.pressEnter();
  await tick();
  setup.mockInput.pressKey("a", { ctrl: true });
  await setup.mockInput.typeText("after?1234[] ");
  setup.mockInput.pressKey("s", { ctrl: true });
  await tick();
  setup.mockInput.pressKey("s", { ctrl: true });
  for (let index = 0; index < 100; index++) {
    if ((await JsonDocument.load(manifest)).get(["name"]) === "after?1234[] ") break;
    await Bun.sleep(20);
  }
  assert.equal((await JsonDocument.load(manifest)).get(["name"]), "after?1234[] ");
  assert.match(await fs.readFile(manifest, "utf8"), /keep this comment/);
  const editing = app.perform("source");
  await tick();
  setup.mockInput.pressKey("a", { ctrl: true });
  await setup.mockInput.typeText("{ broken: ");
  setup.mockInput.pressKey("s", { ctrl: true });
  await tick();
  assert.match(setup.captureCharFrame(), /broken/);
  assert.equal((await JsonDocument.load(manifest)).get(["name"]), "after?1234[] ");
  setup.mockInput.pressEscape();
  await editing;
  await app.shutdown();
  await setup.dispose();
  setup = undefined;
  app = undefined;
  console.log(
    "PASS real OpenTUI literal field input/save, comment preservation, invalid-source draft and unchanged disk",
  );

  setup = await createTestRenderer({
    width: 100,
    height: 30,
    exitOnCtrlC: false,
  });
  const dialogs = new Dialogs(setup.renderer, () => {});
  const handler = (key) => dialogs.handleKey(key);
  setup.renderer.keyInput.on("keypress", handler);
  const form = dialogs.form("Credential", [
    { key: "password", label: "Password", secret: true },
  ]);
  await setup.mockInput.typeText("outdated");
  setup.mockInput.pressKey("a", { ctrl: true });
  await setup.mockInput.pasteBracketedText("fixture-private");
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  assert.doesNotMatch(frame, /fixture-private/);
  assert.match(frame, /\*{10}/);
  setup.mockInput.pressKey("s", { ctrl: true });
  assert.equal((await form).password, "fixture-private");
  setup.renderer.keyInput.off("keypress", handler);
  await setup.dispose();
  setup = undefined;
  console.log("PASS credential text never enters the terminal render surface");
} finally {
  if (app) await app.shutdown();
  if (setup) await setup.dispose();
  if (previous === undefined) delete process.env.LAZYHB_STATE_DIR;
  else process.env.LAZYHB_STATE_DIR = previous;
  await fs.rm(root, { recursive: true, force: true });
}
