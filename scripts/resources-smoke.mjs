import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { zipSync, strToU8 } from "fflate";
import { JsonDocument } from "../dist/config.js";
import { iconSlots } from "../dist/icon-slots.js";
import {
  generateIcons,
  validateIcon,
  generateStoryboard,
  validateSplash,
  importNativePlugin,
} from "../dist/assets.js";
const root = await fs.mkdtemp(join(tmpdir(), "lazyhb-resources-"));
try {
  const input = join(root, "original.png");
  await sharp({
    create: { width: 120, height: 80, channels: 4, background: "#f2000070" },
  })
    .png()
    .toFile(input);
  const original = await fs.readFile(input);
  const document = await JsonDocument.load(join(root, "manifest.json"));
  await generateIcons(root, input, document);
  for (const slot of iconSlots("uni-app"))
    await validateIcon(
      join(root, document.get(slot.path)),
      slot.size,
      slot.ios,
    );
  const slot = iconSlots("uni-app")[0];
  const manual = document.get(slot.path);
  const before = await fs.readFile(join(root, manual));
  document.delete(iconSlots("uni-app")[2].path);
  await generateIcons(root, input, document, true);
  assert.equal(document.get(slot.path), manual);
  assert.deepEqual(await fs.readFile(join(root, manual)), before);
  assert.deepEqual(await fs.readFile(input), original);
  await assert.rejects(validateIcon(input, 120, true));
  const xDirectory = join(root, "x");
  await fs.mkdir(xDirectory);
  await fs.writeFile(join(xDirectory, "manifest.json"), '{"uni-app-x":{}}');
  const x = await JsonDocument.load(join(xDirectory, "manifest.json"));
  await generateIcons(xDirectory, input, x);
  await validateIcon(
    join(xDirectory, x.get(["app-ios", "distribute", "icons", "appstore"])),
    1024,
    true,
  );
  assert.equal(x.get(["app-plus"]), null);
  console.log(
    "PASS real classic/x icon generation, every declared size, iOS alpha and manual-source preservation",
  );

  const output = await generateStoryboard(root, input);
  assert.match((await validateSplash(output)).join("\n"), /storyboard/);
  const bad = join(root, "bad.zip");
  await fs.writeFile(
    bad,
    zipSync({ "../escape.storyboard": strToU8("<document/>") }),
  );
  await assert.rejects(validateSplash(bad));
  await fs.writeFile(
    bad,
    zipSync({
      "Launch.storyboard": strToU8(
        '<document><resources><image name="missing.png"/></resources></document>',
      ),
    }),
  );
  await assert.rejects(validateSplash(bad), /缺少/);
  await fs.writeFile(
    bad,
    zipSync({
      "Launch.storyboard": strToU8(
        '<!DOCTYPE document [<!ENTITY x "unsafe">]><document/>',
      ),
    }),
  );
  await assert.rejects(validateSplash(bad), /DTD/);
  const nine = join(root, "bad.9.png");
  await fs.copyFile(input, nine);
  await assert.rejects(validateSplash(nine), /9-patch/);
  console.log(
    "PASS generated storyboard ZIP and rejection of traversal, missing images, DTD, invalid 9-patch",
  );

  const source = join(root, "plugin-source");
  await fs.mkdir(join(source, "android"), { recursive: true });
  const metadata = {
    id: "fixture.plugin",
    name: "Fixture",
    version: "1.0",
    _dp_nativeplugin: {
      android: {
        integrateType: "aar",
        plugins: [
          { type: "module", name: "Fixture", class: "org.example.Fixture" },
        ],
      },
    },
  };
  await fs.writeFile(join(source, "package.json"), JSON.stringify(metadata));
  await fs.writeFile(
    join(source, "android", "fixture.aar"),
    "fixture binary content",
  );
  document.set(["app-plus", "nativePlugins", metadata.id], {
    options: { enabled: true },
  });
  assert.equal(await importNativePlugin(root, source, document), metadata.id);
  assert.equal(
    await fs.readFile(
      join(root, "nativeplugins", metadata.id, "android/fixture.aar"),
      "utf8",
    ),
    "fixture binary content",
  );
  assert.equal(
    document.get([
      "app-plus",
      "nativePlugins",
      metadata.id,
      "options",
      "enabled",
    ]),
    true,
  );
  const saved = document.text;
  await assert.rejects(importNativePlugin(root, source, document));
  assert.equal(document.text, saved);
  await importNativePlugin(
    root,
    join(root, "nativeplugins", metadata.id),
    document,
  );
  document.set(
    ["app-plus", "nativePlugins", metadata.id, "__plugin_info__", "isCloud"],
    true,
  );
  await assert.rejects(importNativePlugin(root, source, document), /云端/);
  document.set(["uni-app-x"], {});
  await assert.rejects(importNativePlugin(root, source, document), /uni-app x/);
  console.log(
    "PASS local plugin atomic publication, options preservation, existing/cloud/x refusal",
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
