import { test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import sharp from "sharp";
import { NativeImage, ImageRenderable } from "@opentui/core";
import { createTestRenderer, setRendererCapabilities, type TestRendererSetup } from "@opentui/core/testing";
import { ProjectFiles, ProjectRegistry } from "../src/projects.js";
import { decodeProjectImage, IMAGE_BYTE_LIMIT } from "../src/image-preview.js";
import { loadFileIcon } from "../src/file-icons.js";
import { Dialogs } from "../src/dialogs.js";
import { Workspace } from "../src/app.js";

const tick = async (setup: TestRendererSetup) => {
  await setup.renderOnce(); await setup.flush();
};
const escape = async (setup: TestRendererSetup) => {
  // Raw ESC is intentionally disambiguated by the terminal parser; await its event, not a guessed delay.
  const received = once(setup.renderer.keyInput, "keypress");
  setup.mockInput.pressEscape();
  await received;
  await setup.flush();
};
const settle = async (setup: TestRendererSetup, predicate: () => boolean) => {
  // UI idle is not filesystem idle; use the same external-IO boundary as ui-operations.
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    await tick(setup);
    if (predicate()) return;
    await fs.stat(tmpdir());
  }
  throw new Error("Native transition did not complete\n" + setup.captureCharFrame());
};
const waitForNode = (setup: TestRendererSetup, id: string) =>
  settle(setup, () => !!setup.renderer.root.findDescendantById(id));

test("confined image consumer decodes pixels and rejects external resources, links and limits", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lazyhb-images-"));
  const project = join(root, "project");
  await fs.mkdir(project);
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch() { requests++; return new Response("unexpected"); } });
  try {
    const files = await ProjectFiles.open(project);
    const rgba = Buffer.from(Array.from({ length: 32 }, (_, index) => index % 8 < 4 ? [255, 0, 0, 255] : [0, 0, 255, 100]).flat());
    for (const format of ["png", "jpeg", "webp", "gif"] as const) {
      await fs.writeFile(join(project, "color." + format), await sharp(rgba, { raw: { width: 8, height: 4, channels: 4 } }).toFormat(format).toBuffer());
      const decoded = await decodeProjectImage(files, "color." + format);
      const image = NativeImage.decode(decoded.source);
      try {
        expect(image.width).toBe(8); expect(image.height).toBe(4);
        const pixels = image.raw().data;
        expect(Array.from(pixels.subarray(0, 4))).not.toEqual(Array.from(pixels.subarray(7 * 4, 8 * 4)));
      }
      finally { image.dispose(); }
    }
    await fs.writeFile(join(project, "color.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="40" height="40" fill="red"/><rect x="40" width="40" height="40" fill="blue" opacity=".4"/></svg>');
    const svg = await decodeProjectImage(files, "color.svg");
    const native = NativeImage.decode(svg.source);
    try { expect(native.width).toBe(80); expect(native.raw().data.some((value, index) => index % 4 === 3 && value < 255)).toBe(true); }
    finally { native.dispose(); }
    const external = `http://127.0.0.1:${server.port}/resource.png`;
    const bad = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="${external}"/></svg>`,
      `<!-- disguised SVG --><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><use href="${external}"/></svg>`,
      `<!DOCTYPE svg [<!ENTITY remote SYSTEM "${external}">]><svg xmlns="http://www.w3.org/2000/svg">&remote;</svg>`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect style="fill:url(${external})" width="10" height="10"/></svg>`,
    ];
    for (let i = 0; i < bad.length; i++) {
      const name = i === 1 ? "external.jpg" : `external${i}.svg`;
      await fs.writeFile(join(project, name), bad[i]);
      await expect(decodeProjectImage(files, name)).rejects.toThrow();
    }
    expect(requests).toBe(0);
    await fs.writeFile(join(root, "outside.png"), await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer());
    let fileLink = false;
    try {
      await fs.symlink(join(root, "outside.png"), join(project, "linked.png"), "file");
      fileLink = true;
    } catch (error) {
      // Windows file symlinks need Developer Mode or elevation; junctions below do not.
      if (!(process.platform === "win32" && error instanceof Error && "code" in error
        && ["EPERM", "EACCES"].includes(String(error.code)))) throw error;
    }
    await fs.symlink(root, join(project, "linked-dir"), process.platform === "win32" ? "junction" : "dir");
    for (const name of ["../outside.png", "linked-dir/outside.png", ...(fileLink ? ["linked.png"] : [])])
      await expect(decodeProjectImage(files, name)).rejects.toThrow();
    await fs.writeFile(join(project, "broken.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await expect(decodeProjectImage(files, "broken.png")).rejects.toThrow();
    const large = await fs.open(join(project, "large.png"), "w");
    await large.truncate(IMAGE_BYTE_LIMIT + 1); await large.close();
    await expect(decodeProjectImage(files, "large.png")).rejects.toThrow();
    await fs.writeFile(join(project, "huge.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"><rect width="100000" height="100000" fill="red"/></svg>');
    await expect(decodeProjectImage(files, "huge.svg")).rejects.toThrow();
  } finally { server.stop(true); await fs.rm(root, { recursive: true, force: true }); }
});

test("blocks file list stays readable on single lines without decoding list icons", async () => {
  const setup = await createTestRenderer({ width: 120, height: 40, exitOnCtrlC: false });
  const dialogs = new Dialogs(setup.renderer, () => {});
  const handler = (key: Parameters<Dialogs["handleKey"]>[0]) => dialogs.handleKey(key);
  setup.renderer.keyInput.on("keypress", handler);
  try {
    const icon = await loadFileIcon("file.ts", false);
    let loads = 0;
    const options = Array.from({ length: 1500 }, (_, at) => ({
      value: String(at), label: `file-${at}.ts`, typeLabel: at % 2 ? "TS" : "文件",
      loadSource: async () => { loads++; return icon.source; },
    }));
    let selected = "1499";
    const choosing = dialogs.fileChoice("Files", options, selected, value => { selected = value; });
    await tick(setup);
    expect(setup.captureCharFrame()).toContain("file-1499.ts");
    expect(setup.renderer.root.findDescendantById("file-browser-icon-0")).toBeUndefined();
    expect(loads).toBe(0);
    const frameLines = setup.captureCharFrame().split("\n");
    const visible = frameLines.flatMap((line, y) => /file-\d+\.ts/.test(line) ? [{ line, y }] : []);
    for (let at = 1; at < visible.length; at++) {
      expect(visible[at].y).toBe(visible[at - 1].y + 1);
      expect(Number(visible[at].line.match(/file-(\d+)\.ts/)![1]))
        .toBe(Number(visible[at - 1].line.match(/file-(\d+)\.ts/)![1]) + 1);
    }
    expect(frameLines.findIndex(line => line.includes("file-1499.ts")))
      .toBe(frameLines.findIndex(line => line.includes("file-1498.ts")) + 1);
    expect(new Set(visible.map(({ line }) => Bun.stringWidth(line.slice(0, line.indexOf("file-"))))).size).toBe(1);
    setup.resize(64, 24); await tick(setup);
    expect(setup.captureCharFrame()).toContain("file-1499.ts");
    setup.mockInput.pressKey("\x1b[5~"); await tick(setup);
    expect(Number(selected)).toBeLessThan(1499);
    setup.mockInput.pressKey("END"); await tick(setup);
    setup.mockInput.pressArrow("up"); await tick(setup);
    expect(selected).toBe("1498");
    setup.mockInput.pressKey("j"); await tick(setup);
    expect(selected).toBe("1499");
    setup.mockInput.pressKey("k"); await tick(setup);
    expect(selected).toBe("1498");
    setup.mockInput.pressKey("o");
    expect(await choosing).toEqual({ value: "1498", operations: true });
    const restored = dialogs.fileChoice("Files", options, selected, value => { selected = value; });
    await tick(setup);
    expect(setup.captureCharFrame()).toContain("file-1498.ts");
    const row = setup.renderer.root.findDescendantById("file-browser-row-0")!;
    const firstVisible = setup.captureCharFrame().split("\n").find(line => /file-\d+\.ts/.test(line))!.match(/file-(\d+)\.ts/)![1];
    await setup.mockMouse.click(row.x + 8, row.y);
    expect(await restored).toEqual({ value: firstVisible, operations: false });
    expect(loads).toBe(0);
    const pixels = Buffer.from(Array.from({ length: 32 }, (_, at) =>
      at % 8 < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]).flat());
    const picture = await sharp(pixels, { raw: { width: 8, height: 4, channels: 4 } }).png().toBuffer();
    const preview = dialogs.image("Preview", picture, "red and blue fixture");
    await tick(setup);
    const rendered = setup.renderer.root.findDescendantById("image-preview") as ImageRenderable;
    await rendered.loadPromise; await tick(setup);
    expect(Array.from(rendered.image!.raw().data)).toEqual(Array.from(pixels));
    const colors = setup.captureSpans().lines.slice(rendered.y, rendered.y + rendered.height)
      .flatMap(line => line.spans).flatMap(span => [span.fg.toInts(), span.bg.toInts()]);
    expect(colors).toContainEqual([255, 0, 0, 255]);
    expect(colors).toContainEqual([0, 0, 255, 255]);
    setup.resize(62, 20); await tick(setup);
    await escape(setup); await preview;
    expect(setup.renderer.root.findDescendantById("image-preview")).toBeUndefined();
  } finally { dialogs.cancelActive(); setup.renderer.keyInput.off("keypress", handler); await setup.dispose(); }
});

test("simulated kitty capability loads only visible icons and clears recycled native pixels", async () => {
  const setup = await createTestRenderer({ width: 64, height: 24, exitOnCtrlC: false });
  const dialogs = new Dialogs(setup.renderer, () => {});
  const handler = (key: Parameters<Dialogs["handleKey"]>[0]) => dialogs.handleKey(key);
  setup.renderer.keyInput.on("keypress", handler);
  try {
    // Controlled protocol coverage, not a claim about the host terminal.
    setRendererCapabilities(setup.renderer, { image_protocol: "kitty", kitty_graphics: false });
    const requested = new Set<number>();
    const red = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#ff0000" } }).png().toBuffer();
    const blue = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#0000ff" } }).png().toBuffer();
    const { promise: pending, resolve: complete } = Promise.withResolvers<Uint8Array>();
    let fail = false;
    const options = Array.from({ length: 1500 }, (_, at) => ({
      value: String(at), label: `entry-${at}.ts`, typeLabel: "TS",
      loadSource: async () => {
        requested.add(at);
        if (at <= 100) return red;
        if (fail) throw new Error("fixture unavailable");
        return pending;
      },
    }));
    const choosing = dialogs.fileChoice("Files", options, "0", () => {});
    await tick(setup);
    expect(requested.size).toBe(0);
    expect(setup.renderer.root.findDescendantById("file-browser-icon-0")).toBeUndefined();
    setRendererCapabilities(setup.renderer, { image_protocol: "kitty", kitty_graphics: true });
    setup.renderer.emit("capabilities", setup.renderer.capabilities!);
    await tick(setup);
    const image = setup.renderer.root.findDescendantById("file-browser-icon-0") as ImageRenderable;
    await image.loadPromise; await tick(setup);
    expect(Array.from(image.image!.raw().data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    expect(requested.has(1499)).toBe(false);
    setup.mockInput.pressKey("END"); await tick(setup);
    expect(image.source).toBeUndefined();
    expect(image.image).toBeNull();
    expect(setup.captureCharFrame()).toContain("entry-1499.ts");
    expect(requested.has(1499)).toBe(true);
    complete(blue); await nextTurn(); await tick(setup);
    await image.loadPromise; await tick(setup);
    expect(Array.from(image.image!.raw().data.subarray(0, 4))).toEqual([0, 0, 255, 255]);
    expect(setup.captureCharFrame()).toContain("entry-1499.ts");
    setup.mockInput.pressKey("HOME"); await tick(setup);
    await image.loadPromise; await tick(setup);
    expect(Array.from(image.image!.raw().data.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    fail = true;
    setup.mockInput.pressKey("END"); await tick(setup);
    expect(image.source).toBeUndefined();
    expect(image.image).toBeNull();
    expect(setup.captureCharFrame()).toContain("TS");
    expect(setup.captureCharFrame()).toContain("entry-1499.ts");
    setRendererCapabilities(setup.renderer, { image_protocol: "blocks", kitty_graphics: false });
    setup.renderer.emit("capabilities", setup.renderer.capabilities!);
    await tick(setup);
    expect(setup.renderer.root.findDescendantById("file-browser-icon-0")).toBeUndefined();
    expect(setup.captureCharFrame()).toContain("entry-1499.ts");
    await escape(setup); await choosing;
  } finally { dialogs.cancelActive(); setup.renderer.keyInput.off("keypress", handler); await setup.dispose(); }
});

test("navigation lists share the full height independently of focus and overlay lifetime", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lazyhb-navigation-"));
  const previous = process.env.LAZYHB_STATE_DIR;
  process.env.LAZYHB_STATE_DIR = join(root, "state");
  const setup = await createTestRenderer({ width: 120, height: 42, exitOnCtrlC: false });
  let app: Workspace | undefined;
  try {
    const project = join(root, "project"); await fs.mkdir(project);
    await fs.writeFile(join(project, "manifest.json"), '{"name":"fixture","appid":"test"}');
    await fs.writeFile(join(project, "z-preview.png"), await sharp({
      create: { width: 40, height: 20, channels: 4, background: { r: 10, g: 180, b: 220, alpha: 0.5 } },
    }).png().toBuffer());
    await new ProjectRegistry().add(project);
    app = new Workspace(setup.renderer, { project, cli: join(root, "missing-cli") });
    await app.init(); await tick(setup);
    const projects = setup.renderer.root.findDescendantById("projects")!;
    const categories = setup.renderer.root.findDescendantById("categories")!;
    expect(categories.visible).toBe(true); expect(projects.visible).toBe(true);
    const expectFilledNavigation = (selected: typeof projects) => {
      const projectPanel = projects.parent!, categoryPanel = categories.parent!;
      expect(Math.abs(projectPanel.height + categoryPanel.height - categoryPanel.parent!.height)).toBeLessThanOrEqual(1);
      expect(projects.visible && categories.visible).toBe(true);
      expect(projects.height).toBeGreaterThanOrEqual(2); expect(categories.height).toBeGreaterThanOrEqual(2);
      expect(selected.parent!.height).toBeGreaterThan((selected === categories ? projects : categories).parent!.height);
    };
    expectFilledNavigation(categories);
    setup.mockInput.pressKey("3"); await tick(setup);
    expect(categories.visible).toBe(true); expectFilledNavigation(categories);
    setup.mockInput.pressKey("1"); await tick(setup);
    expect(projects.visible).toBe(true); expect(categories.visible).toBe(true);
    expectFilledNavigation(projects);
    setup.mockInput.pressKey("4"); await tick(setup);
    expect(projects.visible).toBe(true); expectFilledNavigation(projects);
    setup.mockInput.pressKey("?"); await tick(setup);
    await escape(setup);
    await setup.waitFor(() => !setup.renderer.root.findDescendantById("shortcut-help"));
    expect(projects.visible).toBe(true);
    setup.mockInput.pressKey("t", { ctrl: true }); await tick(setup);
    expect(projects.visible).toBe(true);
    setup.resize(72, 24); await tick(setup);
    expectFilledNavigation(projects);
    setup.mockInput.pressKey("2"); await tick(setup);
    await setup.waitFor(() => categories.visible);
    expect(categories.visible).toBe(true); expect(projects.visible).toBe(true);
    await settle(setup, () => setup.captureCharFrame().includes("CLI 不可执行或不存在"));
    const managing = app.perform("files");
    await waitForNode(setup, "file-browser-list");
    setup.mockInput.pressKey("END"); await tick(setup); setup.mockInput.pressEnter();
    await waitForNode(setup, "image-preview");
    const preview = setup.renderer.root.findDescendantById("image-preview") as ImageRenderable;
    await preview.loadPromise; await tick(setup);
    expect(preview.image?.width).toBe(40); expect(preview.image?.height).toBe(20);
    expect(preview.image?.raw().data[3]).toBe(128);
    await escape(setup);
    await waitForNode(setup, "file-browser-list");
    expect(setup.captureCharFrame()).toContain("z-preview.png");
    setup.mockInput.pressKey("o"); await tick(setup);
    setup.mockInput.pressEnter();
    await waitForNode(setup, "image-preview");
    await escape(setup);
    await waitForNode(setup, "file-browser-list");
    await escape(setup); await managing;
  } finally {
    if (app) await app.shutdown(); await setup.dispose();
    if (previous === undefined) delete process.env.LAZYHB_STATE_DIR; else process.env.LAZYHB_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("file browser h/l traverses confined directories, restores selection and leaves editor text alone", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "lazyhb-file-hl-"));
  const previous = process.env.LAZYHB_STATE_DIR;
  process.env.LAZYHB_STATE_DIR = join(root, "state");
  const setup = await createTestRenderer({ width: 120, height: 42, exitOnCtrlC: false });
  let app: Workspace | undefined;
  try {
    const project = join(root, "project");
    const folder = join(project, "z-folder");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(join(project, "manifest.json"), '{"name":"fixture","appid":"test"}');
    await fs.writeFile(join(folder, "a-note.txt"), "EDIT_SENTINEL");
    await fs.writeFile(join(folder, "z-preview.png"), await sharp({
      create: { width: 8, height: 4, channels: 4, background: "red" },
    }).png().toBuffer());
    await new ProjectRegistry().add(project);
    app = new Workspace(setup.renderer, { project, cli: join(root, "missing-cli") });
    await app.init();
    await settle(setup, () => setup.captureCharFrame().includes("CLI 不可执行或不存在"));
    const managing = app.perform("files");
    await waitForNode(setup, "file-browser-list");
    const press = async (key: string) => { setup.mockInput.pressKey(key); await tick(setup); };
    const inFolder = () => setup.captureCharFrame().includes("a-note.txt");
    await press("END"); await press("k"); await press("l");
    await settle(setup, inFolder);
    await press("h");
    await settle(setup, () => !!setup.renderer.root.findDescendantById("file-browser-list") && !inFolder());
    // No reselection: returning to the parent retains the directory highlight.
    await press("h");
    await settle(setup, () => setup.captureCharFrame().includes("manifest.json"));
    await press("l");
    await settle(setup, inFolder);
    await press("END"); await press("l");
    await waitForNode(setup, "image-preview");
    const image = setup.renderer.root.findDescendantById("image-preview") as ImageRenderable;
    await image.loadPromise; await tick(setup);
    expect(image.image?.width).toBe(8);
    await escape(setup); await waitForNode(setup, "file-browser-list");
    await press("l"); await waitForNode(setup, "image-preview");
    await escape(setup); await waitForNode(setup, "file-browser-list");
    await press("k"); await press("l");
    await settle(setup, () => setup.captureCharFrame().includes("编辑 UTF-8 文本"));
    setup.mockInput.pressEnter();
    await settle(setup, () => setup.captureCharFrame().includes("EDIT_SENTINEL"));
    await press("h"); await press("l");
    expect(setup.renderer.root.findDescendantById("file-browser-list")).toBeUndefined();
    setup.mockInput.pressKey("s", { ctrl: true });
    await waitForNode(setup, "file-browser-list");
    const edited = await fs.readFile(join(folder, "a-note.txt"), "utf8");
    expect(edited).toContain("hl");
    expect(edited).toContain("EDIT_SENTINEL");
    if (process.env.LAZYHB_UI_PROOF_DIR) {
      await fs.mkdir(process.env.LAZYHB_UI_PROOF_DIR, { recursive: true });
      await fs.writeFile(join(process.env.LAZYHB_UI_PROOF_DIR, "file-hl-consumer.txt"), setup.captureCharFrame());
    }
    // Special rows still use the same Enter action through l.
    await press("HOME"); await press("l"); await managing;
    expect(setup.renderer.root.findDescendantById("file-browser-list")).toBeUndefined();
  } finally {
    if (app) await app.shutdown(); await setup.dispose();
    if (previous === undefined) delete process.env.LAZYHB_STATE_DIR; else process.env.LAZYHB_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
