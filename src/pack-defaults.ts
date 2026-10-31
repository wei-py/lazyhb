import { resolve } from "node:path";
import { projectKind, type JsonDocument } from "./config.js";
import { ProjectFiles } from "./projects.js";

type PackDefault = { value: string; source: string };
type Mapping = readonly [parameter: string, key: string, filePath?: boolean];

const android: readonly Mapping[] = [
  ["android.packagename", "packagename"],
  ["android.certfile", "certfile", true],
  ["android.certalias", "certalias"],
  ["android.androidpacktype", "androidpacktype"],
];
const ios: readonly Mapping[] = [
  ["ios.bundle", "appid"],
  ["ios.certfile", "certfile", true],
  ["ios.profile", "profile", true],
  ["dsyms", "dSYMs"],
];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read project-local, non-secret suggestions only; callers still choose what to submit. */
export async function loadPackDefaults(
  projectPath: string,
  document: JsonDocument,
): Promise<Map<string, PackDefault>> {
  const files = await ProjectFiles.open(projectPath);
  const defaults = new Map<string, PackDefault>();
  const add = (parameter: string, value: unknown, source: string, filePath = false): void => {
    if (defaults.has(parameter)) return;
    if (typeof value !== "string" && typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))) return;
    const text = String(value);
    if (!text.trim()) return;
    // Certificate contents are never opened. Relative paths belong to the project,
    // not to the manifest's directory or the saved configuration's directory.
    defaults.set(parameter, { value: filePath ? resolve(files.root, text) : text, source });
  };

  if (projectKind(document.data) === "uni-app") {
    for (const [platform, mappings] of [["android", android], ["ios", ios]] as const) {
      for (const [parameter, key, filePath] of mappings) {
        const path = ["app-plus", "distribute", platform, key];
        add(parameter, document.get(path), `${document.path}#/${path.join("/")}`, filePath);
      }
    }
  }
  // The catalog has no x package/bundle manifest mapping. In particular, never
  // borrow a stale app-plus subtree from a uni-app x manifest.
  const saved: readonly [string, readonly Mapping[]][] = [
    [".lazyapp/platforms/android/config.json", [["android.packagename", "applicationId"]]],
    [".lazyapp/platforms/android/production/config.json", [
      ["android.certfile", "keystore", true], ["android.certalias", "alias"],
    ]],
    [".lazyapp/platforms/ios/config.json", [["ios.bundle", "bundleId"]]],
    [".lazyapp/platforms/ios/production/config.json", [
      ["ios.certfile", "certificate", true], ["ios.profile", "provisioningProfile", true],
    ]],
  ];
  for (const [relative, mappings] of saved) {
    let text: string;
    try {
      text = await files.read(relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(`无法读取打包默认值：${relative}`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
      if (!record(data)) throw new Error();
    } catch {
      // Parser errors can contain source fragments, including stored passwords.
      throw new Error(`打包默认值配置不是有效 JSON 对象：${relative}`);
    }
    for (const [parameter, key, filePath] of mappings) {
      if (Object.hasOwn(data, key)) add(parameter, data[key], `${relative}#/${key}`, filePath);
    }
  }
  return defaults;
}
