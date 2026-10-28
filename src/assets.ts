import * as fs from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  isAbsolute,
  sep,
} from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import JSON5 from "json5";
import { zipSync, unzipSync, strToU8 } from "fflate";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { JsonDocument, manifestPath, projectKind } from "./config.js";
import { iconSlots } from "./icon-slots.js";
import { ProjectFiles } from "./projects.js";

const MAX_PIXELS = 40_000_000;
const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
async function resourceRoot(
  project: string,
  document?: JsonDocument,
): Promise<string> {
  const lexical = resolve(project);
  const canonical = await fs.realpath(project);
  const source = dirname(document?.path ?? (await manifestPath(project)));
  const root = await fs.realpath(source);
  const suffix = relative(canonical, root);
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(".." + sep))
    throw new Error("manifest 不在所选项目内");
  const originalSuffix = relative(lexical, source);
  const originalSpelling =
    !isAbsolute(originalSuffix) &&
    originalSuffix !== ".." &&
    !originalSuffix.startsWith(".." + sep);
  let current = originalSpelling ? lexical : canonical;
  for (const part of (originalSpelling
    ? originalSuffix
    : relative(canonical, source)
  )
    .split(sep)
    .filter(Boolean)) {
    if (part === "..") throw new Error("manifest 路径越出项目");
    current = join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink())
      throw new Error("资源目录不允许链接或 junction");
  }
  return root;
}
async function destination(
  root: string,
  name: string,
  createParents = false,
): Promise<string> {
  if (
    isAbsolute(name) ||
    name.split(/[\\/]/).includes("..") ||
    name.includes("\0")
  )
    throw new Error("资源目标必须在项目内部");
  const parts = name.split("/").filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    try {
      const info = await fs.lstat(current);
      if (info.isSymbolicLink())
        throw new Error("资源路径不允许链接或 junction");
      if (index < parts.length - 1 && !info.isDirectory())
        throw new Error("资源父路径不是目录");
    } catch (error) {
      if (!absent(error)) throw error;
      if (createParents && index < parts.length - 1) {
        try {
          await fs.mkdir(current);
        } catch (race) {
          if ((race as NodeJS.ErrnoException).code !== "EEXIST") throw race;
        }
        if ((await fs.lstat(current)).isSymbolicLink())
          throw new Error("资源父路径变为链接");
      }
    }
  }
  return current;
}
function backgroundColor(value: string): string {
  if (!/^#[a-f\d]{6}$/i.test(value))
    throw new Error("背景色必须是无透明通道的 #RRGGBB");
  return value;
}
async function imageData(filename: string): Promise<Buffer> {
  const info = await fs.stat(filename);
  if (!info.isFile() || info.size > 64 * 1024 * 1024)
    throw new Error("原图必须为最多 64 MiB 的图片文件");
  const bytes = await fs.readFile(filename);
  const metadata = await sharp(bytes, {
    limitInputPixels: MAX_PIXELS,
    failOn: "warning",
  }).metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > MAX_PIXELS ||
    (metadata.pages ?? 1) > 1
  )
    throw new Error("图片最多 4000 万像素，不接受多帧图片");
  return bytes;
}
async function atomicBytes(
  filename: string,
  content: Uint8Array,
  exclusive = false,
): Promise<void> {
  const temporary = join(dirname(filename), ".lazyhb-" + randomUUID());
  let mode = 0o644;
  try {
    const info = await fs.lstat(filename);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 32 * 1024 * 1024)
      throw new Error("资源目标不是可覆盖的普通文件");
    mode = info.mode & 0o777;
  } catch (error) {
    if (!absent(error)) throw error;
  }
  const handle = await fs.open(temporary, "wx", mode);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (exclusive) await fs.link(temporary, filename);
    else await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
export async function validateIcon(
  filename: string,
  size: number,
  ios = false,
): Promise<string[]> {
  const bytes = await imageData(filename);
  const image = sharp(bytes, {
    limitInputPixels: MAX_PIXELS,
    failOn: "warning",
  });
  const metadata = await image.metadata();
  if (metadata.format !== "png") throw new Error("图标必须是真正的 PNG 文件");
  if (metadata.width !== size || metadata.height !== size)
    throw new Error(
      `此图标槽要求 ${size}×${size}，实际 ${metadata.width}×${metadata.height}`,
    );
  if (ios && metadata.hasAlpha)
    throw new Error("iOS 图标不能有 alpha 通道；使用生成图标去透明");
  await image.raw().toBuffer();
  return [`有效 PNG 图标 ${size}×${size}`];
}
export async function generateIcons(
  project: string,
  source: string,
  document: JsonDocument,
  preserveManual = true,
  background = "#ffffff",
): Promise<string[]> {
  const root = await resourceRoot(project, document);
  const bytes = await imageData(source);
  backgroundColor(background);
  const input = await fs.realpath(source);
  const original = document.text;
  const slots = iconSlots(projectKind(document.data));
  const protectedFiles = new Set(
    slots.flatMap((slot) => {
      const value = document.get(slot.path);
      return preserveManual && typeof value === "string" && value
        ? [resolve(root, value)]
        : [];
    }),
  );
  const updates: { path: string[]; value: string }[] = [];
  const pending = new Map<string, Buffer>();
  for (const slot of slots) {
    if (preserveManual && document.get(slot.path)) continue;
    let name = `unpackage/res/icons/${slot.ios ? "ios" : "android"}-${slot.size}x${slot.size}.png`;
    let target = await destination(root, name);
    if (resolve(target) === input) throw new Error("输出图标不能覆盖源图");
    if (protectedFiles.has(resolve(target))) {
      name = name.replace(
        ".png",
        "-generated-" + randomUUID().slice(0, 8) + ".png",
      );
      target = await destination(root, name);
    }
    if (!pending.has(target)) {
      let image = sharp(bytes, {
        limitInputPixels: MAX_PIXELS,
        failOn: "warning",
      })
        .rotate()
        .resize(slot.size, slot.size, {
          fit: "cover",
          position: "centre",
          kernel: "lanczos3",
        });
      if (slot.ios)
        image = image
          .flatten({ background })
          .removeAlpha()
          .toColourspace("srgb");
      pending.set(target, await image.png().toBuffer());
    }
    updates.push({ path: slot.path, value: name });
  }
  const previous = new Map<string, Buffer | null>();
  try {
    for (const update of updates) document.set(update.path, update.value);
    for (const [target, content] of pending) {
      await destination(
        root,
        relative(root, target).split(sep).join("/"),
        true,
      );
      try {
        const info = await fs.lstat(target);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size > 32 * 1024 * 1024
        )
          throw new Error("目标不是可覆盖图标");
        previous.set(target, await fs.readFile(target));
      } catch (error) {
        if (!absent(error)) throw error;
        previous.set(target, null);
      }
      await atomicBytes(target, content);
    }
  } catch (error) {
    document.replaceSource(original);
    for (const [target, content] of previous) {
      if (content === null) await fs.rm(target, { force: true });
      else await atomicBytes(target, content);
    }
    throw error;
  }
  return [...pending.keys()];
}
interface ZipEntry {
  name: string;
  size: number;
}
function zipEntries(bytes: Buffer): ZipEntry[] {
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--)
    if (
      bytes.readUInt32LE(end) === 0x06054b50 &&
      end + 22 + bytes.readUInt16LE(end + 20) === bytes.length
    )
      break;
  if (end < 0 || bytes.length < 22 || end < bytes.length - 65557)
    throw new Error("无效 ZIP 目录");
  const count = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const directoryEnd = cursor + bytes.readUInt32LE(end + 12);
  if (
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== count ||
    count > 256 ||
    directoryEnd !== end
  )
    throw new Error("ZIP 不支持多卷、ZIP64，且最多 256 文件");
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error("无效 ZIP 条目");
    const length = bytes.readUInt16LE(cursor + 28);
    const extra = bytes.readUInt16LE(cursor + 30);
    const comment = bytes.readUInt16LE(cursor + 32);
    const size = bytes.readUInt32LE(cursor + 24);
    const type = (bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000;
    if (cursor + 46 + length + extra + comment > end)
      throw new Error("ZIP 条目越界");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(cursor + 46, cursor + 46 + length),
    );
    if (
      !name ||
      /[\\/\x00-\x1f]/.test(name) ||
      [".", ".."].includes(name) ||
      seen.has(name) ||
      (type && type !== 0x8000) ||
      bytes.readUInt16LE(cursor + 8) & 1
    )
      throw new Error(
        "ZIP 必须只含根目录常规文件，不允许重名、链接、加密或路径穿越",
      );
    if (size > 32 * 1024 * 1024 || (total += size) > 64 * 1024 * 1024)
      throw new Error("ZIP 单文件最多 32 MiB，总计最多 64 MiB");
    seen.add(name);
    entries.push({ name, size });
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== directoryEnd) throw new Error("ZIP 目录长度不匹配");
  return entries;
}
export async function validateSplash(filename: string): Promise<string[]> {
  if (filename.toLowerCase().endsWith(".zip")) {
    if ((await fs.stat(filename)).size > 80 * 1024 * 1024)
      throw new Error("storyboard ZIP 文件过大");
    const bytes = await fs.readFile(filename);
    const entries = zipEntries(bytes);
    const storyboards = entries.filter((entry) =>
      entry.name.toLowerCase().endsWith(".storyboard"),
    );
    if (storyboards.length !== 1)
      throw new Error("ZIP 必须有且仅有一个 .storyboard");
    const contents = unzipSync(bytes);
    for (const entry of entries)
      if (contents[entry.name]?.length !== entry.size)
        throw new Error("ZIP 解压大小不匹配");
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(
      contents[storyboards[0].name],
    );
    if (/<!DOCTYPE|<!ENTITY/i.test(xml))
      throw new Error("不接受 DTD 或实体声明");
    if (XMLValidator.validate(xml) !== true)
      throw new Error("storyboard XML 无效");
    const tree = new XMLParser({ ignoreAttributes: false }).parse(
      xml,
    ) as Record<string, unknown>;
    if (!Object.hasOwn(tree, "document"))
      throw new Error("storyboard 根元素必须是 document");
    const pngs = entries.filter((entry) =>
      entry.name.toLowerCase().endsWith(".png"),
    );
    const references = new Set<string>();
    const visit = (value: unknown, resources = false): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item, resources);
      } else if (object(value)) {
        if (typeof value["@_image"] === "string")
          references.add(value["@_image"]);
        if (resources && typeof value["@_name"] === "string")
          references.add(value["@_name"]);
        for (const [key, child] of Object.entries(value))
          if (!key.startsWith("@_"))
            visit(child, (key === "image" && resources) || key === "resources");
      }
    };
    visit(tree.document);
    for (const name of references)
      if (
        !pngs.some(
          (entry) =>
            entry.name === name ||
            entry.name.startsWith(name.replace(/\.[^.]+$/, "") + "@"),
        )
      )
        throw new Error("storyboard 缺少引用图片：" + name);
    for (const entry of pngs) {
      const image = sharp(contents[entry.name], {
        limitInputPixels: MAX_PIXELS,
        failOn: "warning",
      });
      if ((await image.metadata()).format !== "png")
        throw new Error("无效 PNG：" + entry.name);
      await image.raw().toBuffer();
    }
    return [
      `storyboard：${storyboards[0].name}`,
      `PNG 资源：${pngs.length}`,
      "ZIP/XML/图片引用检查通过（不是 Xcode 编译验证）",
    ];
  }
  const bytes = await imageData(filename);
  const image = sharp(bytes, {
    limitInputPixels: MAX_PIXELS,
    failOn: "warning",
  });
  const metadata = await image.metadata();
  if (metadata.format !== "png") throw new Error("启动图片必须是真正的 PNG");
  const facts = [`PNG：${metadata.width}×${metadata.height}`];
  if (filename.toLowerCase().endsWith(".9.png")) {
    const { data, info } = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    if (width < 3 || height < 3) throw new Error("9-patch 至少 3×3");
    const black = (x: number, y: number) => {
      const index = (y * width + x) * 4;
      return (
        data[index] === 0 &&
        data[index + 1] === 0 &&
        data[index + 2] === 0 &&
        data[index + 3] === 255
      );
    };
    const border = (x: number, y: number) => {
      if (data[(y * width + x) * 4 + 3] !== 0 && !black(x, y))
        throw new Error("9-patch 边框只能透明或不透明黑色");
    };
    for (let x = 0; x < width; x++) {
      border(x, 0);
      border(x, height - 1);
    }
    for (let y = 0; y < height; y++) {
      border(0, y);
      border(width - 1, y);
    }
    if (
      !Array.from({ length: width - 2 }, (_, index) =>
        black(index + 1, 0),
      ).some(Boolean) ||
      !Array.from({ length: height - 2 }, (_, index) =>
        black(0, index + 1),
      ).some(Boolean)
    )
      throw new Error("9-patch 顶边/左边缺少拉伸标记");
    facts.push("9-patch 边框与拉伸标记检查通过");
  } else await image.raw().toBuffer();
  return facts;
}
export async function generateStoryboard(
  project: string,
  image: string,
  background = "#ffffff",
): Promise<string> {
  const root = await resourceRoot(project);
  backgroundColor(background);
  const bytes = await imageData(image);
  const png = await sharp(bytes, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize({
      width: 2048,
      height: 2048,
      fit: "inside",
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();
  const rgb = [1, 3, 5].map(
    (offset) => parseInt(background.slice(offset, offset + 2), 16) / 255,
  );
  const xml = `<?xml version="1.0" encoding="UTF-8"?><document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0" targetRuntime="iOS.CocoaTouch" propertyAccessControl="none" useAutolayout="YES" launchScreen="YES" useTraitCollections="YES" initialViewController="launch-controller"><device id="retina6_12" orientation="portrait" appearance="light"/><dependencies><plugIn identifier="com.apple.InterfaceBuilder.IBCocoaTouchPlugin" version="23501"/></dependencies><scenes><scene sceneID="launch-scene"><objects><viewController id="launch-controller" sceneMemberID="viewController"><view key="view" contentMode="scaleToFill" id="launch-view"><rect key="frame" x="0" y="0" width="393" height="852"/><autoresizingMask key="autoresizingMask" widthSizable="YES" heightSizable="YES"/><subviews><imageView clipsSubviews="YES" userInteractionEnabled="NO" contentMode="scaleAspectFit" image="dc_launchscreen.png" translatesAutoresizingMaskIntoConstraints="NO" id="launch-image"><rect key="frame" x="0" y="0" width="393" height="852"/></imageView></subviews><color key="backgroundColor" red="${rgb[0]}" green="${rgb[1]}" blue="${rgb[2]}" alpha="1" colorSpace="custom" customColorSpace="sRGB"/><constraints><constraint firstItem="launch-image" firstAttribute="leading" secondItem="launch-view" secondAttribute="leading" id="leading"/><constraint firstItem="launch-image" firstAttribute="trailing" secondItem="launch-view" secondAttribute="trailing" id="trailing"/><constraint firstItem="launch-image" firstAttribute="top" secondItem="launch-view" secondAttribute="top" id="top"/><constraint firstItem="launch-image" firstAttribute="bottom" secondItem="launch-view" secondAttribute="bottom" id="bottom"/></constraints></view></viewController><placeholder placeholderIdentifier="IBFirstResponder" id="responder" sceneMemberID="firstResponder"/></objects></scene></scenes><resources><image name="dc_launchscreen.png" width="393" height="852"/></resources></document>`;
  const name = `unpackage/res/splash/CustomStoryboard-${randomUUID().slice(0, 10)}.zip`;
  const target = await destination(root, name, true);
  await atomicBytes(
    target,
    zipSync({
      "LaunchScreen.storyboard": strToU8(xml),
      "dc_launchscreen.png": png,
    }),
    true,
  );
  try {
    await validateSplash(target);
    return target;
  } catch (error) {
    await fs.rm(target, { force: true });
    throw error;
  }
}
export async function importNativePlugin(
  project: string,
  directory: string,
  document: JsonDocument,
): Promise<string> {
  if (projectKind(document.data) === "uni-app-x")
    throw new Error(
      "uni-app x 请使用 UTS/uni_modules，不能导入 classic nativeplugins",
    );
  const root = await resourceRoot(project, document);
  directory = resolve(directory);
  const info = await fs.lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("插件必须是非链接目录");
  const metadataPath = join(directory, "package.json");
  const metadataInfo = await fs.lstat(metadataPath);
  if (
    metadataInfo.isSymbolicLink() ||
    !metadataInfo.isFile() ||
    metadataInfo.size > 2 * 1024 * 1024
  )
    throw new Error("缺少合法 package.json");
  const metadata: unknown = JSON5.parse(
    await fs.readFile(metadataPath, "utf8"),
  );
  if (!object(metadata)) throw new Error("package.json 必须是对象");
  const id = metadata.id ?? basename(directory);
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(id) ||
    id.includes("..")
  )
    throw new Error("插件 ID 不是安全目录名");
  const native = metadata._dp_nativeplugin;
  if (!object(native))
    throw new Error("缺少 _dp_nativeplugin；不是本地原生插件");
  const platforms: string[] = [];
  for (const [platform, types] of [
    ["android", ["aar", "jar"]],
    ["ios", ["framework", "library"]],
  ] as const) {
    const settings = native[platform];
    if (!settings) continue;
    if (
      !object(settings) ||
      !types.some((type) => type === settings.integrateType)
    )
      throw new Error(platform + " integrateType 无效");
    const folder = await fs.lstat(join(directory, platform));
    if (folder.isSymbolicLink() || !folder.isDirectory())
      throw new Error("缺少非链接平台目录");
    if (
      !Array.isArray(settings.plugins) ||
      !settings.plugins.length ||
      settings.plugins.some(
        (item) =>
          !object(item) ||
          !["module", "component"].includes(String(item.type)) ||
          typeof item.name !== "string" ||
          !item.name ||
          typeof item.class !== "string" ||
          !item.class,
      )
    )
      throw new Error(platform + " plugins 必须有有效 type/name/class");
    platforms.push(platform);
  }
  if (!platforms.length) throw new Error("插件未声明 Android 或 iOS 实现");
  const validateTree = async (folder: string, depth = 0): Promise<void> => {
    if (depth > 64) throw new Error("插件目录层级过深");
    for (const name of await fs.readdir(folder)) {
      const filename = join(folder, name);
      const s = await fs.lstat(filename);
      if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()))
        throw new Error("插件不允许链接、设备或特殊文件");
      if (s.isDirectory()) await validateTree(filename, depth + 1);
    }
  };
  await validateTree(directory);
  const target = await destination(root, `nativeplugins/${id}`);
  const existing = document.get(["app-plus", "nativePlugins", id], {});
  if (
    !object(existing) ||
    (object(existing.__plugin_info__) && existing.__plugin_info__.isCloud)
  )
    throw new Error("已有同 ID 不兼容或云端插件配置");
  const original = document.text;
  try {
    document.set(["app-plus", "nativePlugins", id], {
      ...existing,
      __plugin_info__: {
        name: metadata.name ?? id,
        description: metadata.description ?? "",
        platforms: platforms.join(","),
        version: String(metadata.version ?? ""),
        isCloud: false,
      },
    });
    if ((await fs.realpath(directory)) !== resolve(target)) {
      await destination(root, `nativeplugins/${id}`, true);
      const temporary = await fs.mkdtemp(
        join(dirname(target), ".lazyhb-plugin-"),
      );
      try {
        const staged = join(temporary, id);
        await fs.cp(directory, staged, {
          recursive: true,
          dereference: false,
          force: false,
          errorOnExist: true,
        });
        await validateTree(staged);
        const files = await ProjectFiles.open(dirname(target));
        await files.move(relative(dirname(target), staged), id);
      } finally {
        await fs.rm(temporary, { recursive: true, force: true });
      }
    }
  } catch (error) {
    document.replaceSource(original);
    throw error;
  }
  return id;
}
