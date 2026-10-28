import { icons } from "@iconify-json/vscode-icons";
import { getIconData, iconToHTML, iconToSVG } from "@iconify/utils";
import sharp from "sharp";

export interface FileIcon {
  readonly id: string;
  readonly svg: string;
}
export interface FileIconImage {
  readonly id: string;
  readonly source: Uint8Array;
}

const directories: Readonly<Record<string, string>> = {
  src: "folder-type-src", test: "folder-type-test", tests: "folder-type-test",
  node_modules: "folder-type-node", ".git": "folder-type-git",
  ".github": "folder-type-github", config: "folder-type-config",
  images: "folder-type-images", img: "folder-type-images",
};
const filenames: Readonly<Record<string, string>> = {
  "package.json": "file-type-npm", "package-lock.json": "file-type-npm",
  "tsconfig.json": "file-type-typescriptdef", "jsconfig.json": "file-type-jsconfig",
  ".gitignore": "file-type-git", ".gitattributes": "file-type-git",
  dockerfile: "file-type-docker", ".env": "file-type-config",
};
const extensions: Readonly<Record<string, string>> = {
  ts: "file-type-typescript", mts: "file-type-typescript", cts: "file-type-typescript",
  tsx: "file-type-reactts", js: "file-type-js", mjs: "file-type-js", cjs: "file-type-js",
  jsx: "file-type-reactjs", json: "file-type-json", jsonc: "file-type-json", json5: "file-type-json5",
  vue: "file-type-vue", html: "file-type-html", htm: "file-type-html", css: "file-type-css",
  scss: "file-type-scss", sass: "file-type-sass", less: "file-type-less",
  md: "file-type-markdown", mdx: "file-type-markdown", markdown: "file-type-markdown",
  png: "file-type-image", jpg: "file-type-image", jpeg: "file-type-image", gif: "file-type-image",
  webp: "file-type-image", avif: "file-type-image", bmp: "file-type-image", ico: "file-type-image",
  tif: "file-type-image", tiff: "file-type-image", svg: "file-type-svg",
  yaml: "file-type-yaml", yml: "file-type-yaml", toml: "file-type-toml",
  ini: "file-type-config", conf: "file-type-config", cfg: "file-type-config",
  txt: "file-type-text", py: "file-type-python", rs: "file-type-rust", go: "file-type-go",
  sh: "file-type-shell", bash: "file-type-shell", zsh: "file-type-shell", svelte: "file-type-svelte",
};
const svgCache = new Map<string, FileIcon>();
const imageCache = new Map<string, Promise<FileIconImage>>();

function iconName(filename: string, directory: boolean): string {
  const name = filename.replaceAll("\\", "/").split("/").pop()!.toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return directory
    ? Object.hasOwn(directories, name) ? directories[name]! : "default-folder"
    : Object.hasOwn(filenames, name) ? filenames[name]!
    : name.endsWith(".d.ts") ? "file-type-typescriptdef"
    : /(?:^|\.)config\.[^.]+$/.test(name) || name.startsWith(".env.") ? "file-type-config"
    : Object.hasOwn(extensions, extension) ? extensions[extension]! : "default-file";
}

const labels: Readonly<Record<string, string>> = {
  "default-file": "文件", "file-type-image": "图片", "file-type-svg": "SVG",
  "file-type-typescript": "TS", "file-type-typescriptdef": "TS",
  "file-type-reactts": "TSX", "file-type-reactjs": "JSX", "file-type-js": "JS",
  "file-type-json": "JSON", "file-type-json5": "JSON", "file-type-npm": "JSON",
  "file-type-text": "文本", "file-type-markdown": "MD", "file-type-config": "配置",
};
/** Text fallback follows exactly the bundled icon classification, without decoding an image. */
export function fileTypeLabel(filename: string, directory: boolean): string {
  if (directory) return "▸";
  const icon = iconName(filename, false);
  return labels[icon] ?? icon.replace("file-type-", "").toUpperCase().slice(0, 6);
}

/** Offline Iconify data shared with UnoCSS's icons preset, not CSS or font glyphs. */
export function fileIcon(filename: string, directory: boolean): FileIcon {
  const icon = iconName(filename, directory);
  const cached = svgCache.get(icon);
  if (cached) return cached;
  const data = getIconData(icons, icon);
  if (!data) throw new Error(`Missing bundled Iconify icon: ${icon}`);
  const built = iconToSVG(data, { width: data.width ?? icons.width ?? 16, height: data.height ?? icons.height ?? 16 });
  const result = Object.freeze({ id: `${icons.prefix}:${icon}`, svg: iconToHTML(built.body, built.attributes) });
  svgCache.set(icon, result);
  return result;
}

/** Decode only requested icons, sharing both in-flight work and completed PNGs. */
export function loadFileIcon(filename: string, directory: boolean): Promise<FileIconImage> {
  const icon = fileIcon(filename, directory);
  const cached = imageCache.get(icon.id);
  if (cached) return cached;
  const pending = sharp(Buffer.from(icon.svg)).resize(32, 32).png().toBuffer()
    .then((source) => ({ id: icon.id, source }))
    .catch((error: unknown) => { imageCache.delete(icon.id); throw error; });
  imageCache.set(icon.id, pending);
  return pending;
}
