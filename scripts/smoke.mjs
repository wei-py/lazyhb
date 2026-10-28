import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  JsonDocument,
  manifestPath,
  projectKind,
  pointer,
  parsePointer,
} from "../dist/config.js";
import {
  categories,
  categoryFields,
  setField,
  disableModule,
} from "../dist/catalog.js";
import { iconSlots } from "../dist/icon-slots.js";
import { loadSettings, saveSettings } from "../dist/settings.js";
import { DEFAULT_THEME } from "../dist/theme.js";
import { fileIcon, loadFileIcon } from "../dist/file-icons.js";
import sharp from "sharp";

// Every mutation is confined to a new disposable directory, never a user's project.
const root = await fs.realpath(
  await fs.mkdtemp(join(tmpdir(), "lazyhb-smoke-")),
);
let passed = 0;
async function check(name, run) {
  await run();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}
const previousStateDirectory = process.env.LAZYHB_STATE_DIR;
process.env.LAZYHB_STATE_DIR = join(root, "state");
async function fixture(name, text = "{}\n") {
  const directory = join(root, name);
  await fs.mkdir(directory);
  await fs.writeFile(join(directory, "manifest.json"), text);
  return directory;
}
async function absent(path) {
  await assert.rejects(fs.lstat(path), { code: "ENOENT" });
}
try {
  await check("file icons distinguish real directories and render offline colored image data", async () => {
    assert.notEqual(fileIcon("source.ts", true).id, fileIcon("source.ts", false).id);
    assert.equal(fileIcon("UNKNOWN.extension", false).id, fileIcon("constructor", false).id);
    assert.equal(fileIcon("SOURCE.TS", false).id, fileIcon("source.ts", false).id);
    const first = loadFileIcon("source.ts", false);
    const [file, directory] = await Promise.all([first, loadFileIcon("source.ts", true)]);
    const decode = async ({ source }) => sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const a = await decode(file), b = await decode(directory);
    assert.notDeepEqual(a.data, b.data);
    let transparent = 0, colored = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if (a.data[i + 3] === 0) transparent++;
      else if (a.data[i] !== a.data[i + 1] || a.data[i + 1] !== a.data[i + 2]) colored++;
    }
    assert.ok(transparent > 0 && colored > 0, "real shaped multicolor pixels, not just an icon identifier");
  });
  await check("settings preserve named choices and sanitize corrupt input without writing", async () => {
    loadSettings();
    await absent(process.env.LAZYHB_STATE_DIR);
    const target = join(process.env.LAZYHB_STATE_DIR, "settings.json");
    const selected = { theme: "catppuccin-dark", cli: "/versions/selected/cli", recentClis: ["/versions/selected/cli", "/versions/other/cli"] };
    saveSettings(selected);
    assert.deepEqual(loadSettings(), selected);
    if (process.platform !== "win32")
      assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
    const invalid = JSON.stringify({ theme: "unknown", cli: " ", recentClis: [null, {}, "first", "first", "", "second"] });
    await fs.writeFile(target, invalid);
    assert.deepEqual(loadSettings(), { theme: DEFAULT_THEME, recentClis: ["first", "second"] });
    assert.equal(await fs.readFile(target, "utf8"), invalid);
    await fs.writeFile(target, "{broken");
    assert.deepEqual(loadSettings(), { theme: DEFAULT_THEME, recentClis: [] });
    assert.equal(await fs.readFile(target, "utf8"), "{broken");
  });
  await check("settings failed writes preserve existing selection and clean temporary files", async () => {
    const directory = process.env.LAZYHB_STATE_DIR;
    const target = join(directory, "settings.json");
    const selected = { theme: "solarized-dark", cli: "/chosen/cli", recentClis: ["/chosen/cli"] };
    saveSettings(selected);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await fs.chmod(directory, 0o500);
      try {
        assert.throws(() => saveSettings({ theme: "gruvbox-light", recentClis: [] }));
        assert.deepEqual(loadSettings(), selected);
      } finally {
        await fs.chmod(directory, 0o700);
      }
    }
    await fs.rename(target, join(directory, "retained.json"));
    await fs.mkdir(target);
    await fs.writeFile(join(target, "sentinel"), "keep");
    assert.throws(() => saveSettings(selected));
    assert.equal(await fs.readFile(join(target, "sentinel"), "utf8"), "keep");
    assert.deepEqual(JSON.parse(await fs.readFile(join(directory, "retained.json"), "utf8")), selected);
    assert.equal((await fs.readdir(directory)).some(name => name.endsWith(".tmp")), false);
    await fs.rm(target, { recursive: true });
    await fs.rename(join(directory, "retained.json"), target);
  });
  await check(
    "classic and x expose all 22 audited categories and correct icon slots",
    async () => {
      for (const kind of ["uni-app", "uni-app-x"]) {
        const items = categories(kind);
        assert.equal(items.length, 22);
        assert.equal(new Set(items.map((item) => item.key)).size, 22);
        assert.ok(items.find((item) => item.key === "harmony-service"));
        assert.ok(items.find((item) => item.key === "source"));
      }
      assert.equal(iconSlots("uni-app").length, 24);
      assert.equal(iconSlots("uni-app-x").length, 5);
      assert.deepEqual(iconSlots("uni-app-x").at(-1), {
        path: ["app-ios", "distribute", "icons", "appstore"],
        size: 1024,
        ios: true,
      });
      assert.equal(projectKind({ "uni-app-x": {} }), "uni-app-x");
      assert.equal(projectKind({ "uni-app-x": false }), "uni-app");
      assert.equal(pointer(["a/b", "~key", ""]), "/a~1b/~0key/");
      assert.deepEqual(parsePointer("/a~1b/~0key/"), ["a/b", "~key", ""]);
      assert.throws(() => parsePointer("name"));
    },
  );
  await check(
    "field edits retain comments, unknown fields, CRLF, BOM and source-draft atomicity",
    async () => {
      const project = await fixture("source");
      const path = join(project, "manifest.json");
      const source =
        "{\r\n  // preserve me\r\n  name: 'old',\r\n  extension: { enabled: true }, // unknown\r\n}\r\n";
      await fs.writeFile(
        path,
        Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(source)]),
      );
      const doc = await JsonDocument.load(path);
      doc.set(["name"], "new");
      doc.set(["networkTimeout", "request"], 9000);
      assert.match(doc.text, /\/\/ preserve me/);
      assert.match(doc.text, /extension: \{ enabled: true \}, \/\/ unknown/);
      assert.ok(doc.text.includes("\r\n"));
      const valid = doc.text;
      assert.throws(() => doc.replaceSource("{ broken: "));
      assert.equal(doc.text, valid);
      assert.throws(() => doc.replaceSource("{ a: 1, a: 2 }"));
      assert.throws(() => doc.replaceSource('{ nested: [{ a: 1, "a": 2 }] }'));
      assert.throws(() => doc.replaceSource('{ a: 1, "\\u0061": 2 }'));
      assert.equal(doc.text, valid);
      assert.throws(() => doc.set(["name", "child"], true));
      assert.equal(doc.text, valid);
      await doc.save();
      assert.equal(doc.dirty, false);
      const bytes = await fs.readFile(path);
      assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
      const loaded = await JsonDocument.load(path);
      assert.equal(loaded.get(["name"]), "new");
      assert.equal(loaded.get(["extension", "enabled"]), true);
      loaded.delete(["name"]);
      assert.match(loaded.text, /preserve me/);
      assert.equal(loaded.get(["name"], "missing"), "missing");
      assert.throws(() => loaded.set(["invalid"], NaN));
      assert.throws(() => loaded.set([], []));
    },
  );
  await check(
    "save rejects external changes, symlinks and first-save races",
    async () => {
      const project = await fixture("conflicts");
      const path = join(project, "manifest.json");
      const doc = await JsonDocument.load(path);
      doc.set(["name"], "ours");
      await fs.writeFile(path, "{external:true}");
      await assert.rejects(doc.save(), /externally/);
      assert.equal(await fs.readFile(path, "utf8"), "{external:true}");
      const missing = join(project, "new.json");
      const fresh = await JsonDocument.load(missing);
      fresh.set(["name"], "draft");
      await fs.writeFile(missing, "{winner:true}");
      await assert.rejects(fresh.save(), /externally/);
      const link = join(project, "linked.json");
      await fs.symlink(path, link);
      await assert.rejects(JsonDocument.load(link), /symbolic/);
      const exclusive = await JsonDocument.load(join(project, "created.json"));
      exclusive.set(["name"], "created");
      await exclusive.save();
      assert.equal(
        (await JsonDocument.load(exclusive.path)).get(["name"]),
        "created",
      );
    },
  );
  await check(
    "manifest lookup prefers root then src without creating files",
    async () => {
      const project = join(root, "layout");
      await fs.mkdir(join(project, "src"), { recursive: true });
      assert.equal(
        await manifestPath(project),
        join(project, "src", "manifest.json"),
      );
      await absent(join(project, "src", "manifest.json"));
      await fs.writeFile(join(project, "manifest.json"), "{}");
      assert.equal(await manifestPath(project), join(project, "manifest.json"));
      await fs.unlink(join(project, "manifest.json"));
      await fs.rmdir(join(project, "src"));
      await fs.symlink(root, join(project, "src"));
      await assert.rejects(manifestPath(project), /symbolic|junction/);
    },
  );
  await check(
    "module operations preserve custom permissions and vapor updates dependent fields",
    async () => {
      const project = await fixture(
        "fields",
        '{"app-plus":{"modules":{"Maps":{"custom":true}},"distribute":{"android":{"permissions":["custom","shared"]}}},"extension":{"leaf":42}}',
      );
      const doc = await JsonDocument.load(join(project, "manifest.json"));
      const maps = categories("uni-app")
        .find((item) => item.key === "modules")
        .fields.find((field) => field.path.at(-1) === "Maps");
      setField(doc, maps, true);
      assert.deepEqual(doc.get(maps.path), { custom: true });
      disableModule(doc, maps);
      assert.equal(doc.get(maps.path), null);
      assert.deepEqual(
        doc.get(["app-plus", "distribute", "android", "permissions"]),
        ["custom", "shared"],
      );
      setField(doc, maps, true);
      disableModule(doc, maps, [0]);
      assert.deepEqual(
        doc.get(["app-plus", "distribute", "android", "permissions"]),
        ["shared"],
      );
      const basic = categories("uni-app").find((item) => item.key === "basic");
      assert.ok(
        categoryFields(basic, doc).some(
          (field) => field.path.join("/") === "extension/leaf",
        ),
      );
      const vapor = categories("uni-app-x")
        .find((item) => item.key === "basic")
        .fields.find((field) => field.path.at(-1) === "vapor");
      setField(doc, vapor, true);
      assert.equal(doc.get(["uni-app-x", "styleIsolationVersion"]), "2");
      assert.equal(doc.get(["uni-app-x", "vapor-render-target"]), "bytecode");
      setField(doc, vapor, false);
      assert.equal(doc.get(["uni-app-x", "vapor-render-target"]), null);
      assert.equal(doc.get(["uni-app-x", "styleIsolationVersion"]), "2");
    },
  );
  console.log(
    `Completed ${passed} manifest scenarios on ${process.platform}/${process.arch}`,
  );
} finally {
  if (previousStateDirectory === undefined) delete process.env.LAZYHB_STATE_DIR;
  else process.env.LAZYHB_STATE_DIR = previousStateDirectory;
  await fs.rm(root, { recursive: true, force: true });
}
await import("./resources-smoke.mjs");
await import("./cli-smoke.mjs");
await import("./task-catalog-smoke.mjs");
await import("./ui-smoke.mjs");
await import("./workflow-consumer-smoke.mjs");
