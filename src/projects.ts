import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  setTimeout as delay,
  setImmediate as yieldTurn,
} from "node:timers/promises";
import { cc, dlopen, ptr, read, type FFIFunction } from "bun:ffi";
import { JsonDocument } from "./config.js";
import { stateDirectory } from "./state.js";

const LIMIT = 2 * 1024 * 1024;
const excluded: Record<string, true> = {
  ".git": true,
  node_modules: true,
  unpackage: true,
  ".venv": true,
};
const expand = (value: string): string =>
  path.resolve(
    value === "~"
      ? homedir()
      : value.startsWith("~/")
        ? path.join(homedir(), value.slice(2))
        : value,
  );
const signature = (s: fs.BigIntStats): string =>
  [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
function alias(value: string): string {
  value = value.trim();
  if (value.length > 512 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("别名最多 512 字符且不能含控制字符");
  return value;
}
export interface Project {
  path: string;
  alias: string;
}
export function projectName(project: Project): string {
  return project.alias || path.basename(project.path) || project.path;
}

interface Directory {
  path: string;
  fd?: number;
}
interface TextRead {
  text: string;
  info: fs.BigIntStats;
}
type NativeCall = (...args: number[]) => number;
interface NativeSystem {
  windows?: {
    MoveFileExW(source: number, target: number, flags: number): boolean;
    GetLastError(): number;
    GetFileAttributesW(path: number): number;
  };
  posix?: {
    symbols: Record<string, NativeCall>;
    rename: string;
    errno: string;
  };
  open?: (
    directory: number,
    path: number,
    flags: number,
    mode: number,
  ) => number;
}
let native: NativeSystem | undefined;
function loadNative(): NativeSystem {
  if (process.platform === "win32") {
    const symbols = dlopen("kernel32.dll", {
      MoveFileExW: { args: ["ptr", "ptr", "u32"], returns: "bool" },
      GetLastError: { args: [], returns: "u32" },
      GetFileAttributesW: { args: ["ptr"], returns: "u32" },
    }).symbols;
    return { windows: symbols as unknown as NativeSystem["windows"] };
  }
  const mac = process.platform === "darwin";
  const rename = mac ? "renameatx_np" : "renameat2";
  const errno = mac ? "__error" : "__errno_location";
  const definitions: Record<string, FFIFunction> = {
    [rename]: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
    renameat: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" },
    unlinkat: { args: ["i32", "ptr", "i32"], returns: "i32" },
    mkdirat: { args: ["i32", "ptr", "u32"], returns: "i32" },
    [errno]: { args: [], returns: "ptr" },
  };
  const candidates = mac
    ? ["/usr/lib/libSystem.B.dylib"]
    : [
        "libc.so.6",
        `/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`,
      ];
  let symbols: Record<string, NativeCall> | undefined;
  for (const name of candidates) {
    try {
      symbols = dlopen(name, definitions).symbols as unknown as Record<
        string,
        NativeCall
      >;
      break;
    } catch {
      /* next libc variant */
    }
  }
  if (!symbols) throw new Error("系统 libc 缺少安全的无覆盖重命名接口");
  const wrapper = cc({
    source: fileURLToPath(new URL("../native/posix.c", import.meta.url)),
    symbols: {
      lazyhb_openat: { args: ["i32", "ptr", "i32", "i32"], returns: "i32" },
    },
  });
  return {
    posix: { symbols, rename, errno },
    open: wrapper.symbols.lazyhb_openat as unknown as NativeSystem["open"],
  };
}
function system() {
  return (native ??= loadNative());
}
function cstring(value: string) {
  return Buffer.from(value + "\0");
}
function wide(value: string) {
  return Buffer.from(value + "\0", "utf16le");
}
function nativeError(filename: string): never {
  const api = system();
  const code = api.windows
    ? api.windows.GetLastError()
    : read.i32(api.posix!.symbols[api.posix!.errno]() as number, 0);
  const error = new Error(
    `文件操作失败 (${code}): ${filename}`,
  ) as NodeJS.ErrnoException;
  error.code = (api.windows ? [80, 183] : [17]).includes(code)
    ? "EEXIST"
    : (api.windows ? [2, 3] : [2]).includes(code)
      ? "ENOENT"
      : "EIO";
  throw error;
}
function isLink(filename: string, info = fs.lstatSync(filename)): boolean {
  if (info.isSymbolicLink()) return true;
  if (process.platform !== "win32") return false;
  const buffer = wide(filename);
  const attributes = system().windows!.GetFileAttributesW(ptr(buffer));
  if (attributes === 0xffffffff) nativeError(filename);
  return !!(attributes & 0x400);
}
function openAt(
  dir: Directory,
  name: string,
  flags: number,
  mode = 0o600,
): number {
  if (dir.fd === undefined)
    return fs.openSync(path.join(dir.path, name), flags, mode);
  const value = cstring(name);
  const fd = system().open!(
    dir.fd,
    ptr(value),
    flags | fs.constants.O_NOFOLLOW,
    mode,
  );
  if (fd < 0) nativeError(path.join(dir.path, name));
  return fd;
}
function statAt(dir: Directory, name: string): fs.BigIntStats {
  const original = fs.lstatSync(path.join(dir.path, name));
  if (isLink(path.join(dir.path, name), original))
    throw new Error("不允许符号链接或 Windows reparse point");
  const fd = openAt(
    dir,
    name,
    fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    return fs.fstatSync(fd, { bigint: true });
  } finally {
    fs.closeSync(fd);
  }
}
function unlinkAt(dir: Directory, name: string, directory = false): void {
  if (dir.fd === undefined) {
    if (directory) fs.rmdirSync(path.join(dir.path, name));
    else fs.unlinkSync(path.join(dir.path, name));
    return;
  }
  const value = cstring(name);
  const flag = directory ? (process.platform === "darwin" ? 0x80 : 0x200) : 0;
  if (system().posix!.symbols.unlinkat(dir.fd, ptr(value), flag) !== 0)
    nativeError(name);
}
function mkdirAt(dir: Directory, name: string): void {
  if (dir.fd === undefined) fs.mkdirSync(path.join(dir.path, name));
  else {
    const value = cstring(name);
    if (system().posix!.symbols.mkdirat(dir.fd, ptr(value), 0o755) !== 0)
      nativeError(name);
  }
}
function renameAt(
  from: Directory,
  source: string,
  to: Directory,
  target: string,
  replace = false,
): void {
  const api = system();
  if (api.windows) {
    const a = wide(path.join(from.path, source));
    const b = wide(path.join(to.path, target));
    if (!api.windows.MoveFileExW(ptr(a), ptr(b), replace ? 1 : 0))
      nativeError(target);
  } else {
    const a = cstring(source);
    const b = cstring(target);
    const posix = api.posix!;
    const result = replace
      ? posix.symbols.renameat(from.fd!, ptr(a), to.fd!, ptr(b))
      : posix.symbols[posix.rename](
          from.fd!,
          ptr(a),
          to.fd!,
          ptr(b),
          process.platform === "darwin" ? 4 : 1,
        );
    if (result !== 0) nativeError(target);
  }
}
function childDirectory(parent: Directory, name: string): Directory {
  const filename = path.join(parent.path, name);
  const info = fs.lstatSync(filename);
  if (isLink(filename, info) || !info.isDirectory())
    throw new Error("不是普通目录，拒绝链接或 junction: " + filename);
  if (parent.fd === undefined) return { path: filename };
  const fd = openAt(
    parent,
    name,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
  );
  if (!fs.fstatSync(fd).isDirectory()) {
    fs.closeSync(fd);
    throw new Error("目录已发生变化");
  }
  return { path: filename, fd };
}
function closeDirectory(dir: Directory): void {
  if (dir.fd !== undefined) fs.closeSync(dir.fd);
}
function relativeParts(value: string): string[] {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  )
    throw new Error("必须使用项目内相对路径");
  const parts = value
    .split(process.platform === "win32" ? /[\\/]/ : /\//)
    .filter((part) => part && part !== ".");
  for (const part of parts) {
    if (part === "..") throw new Error("不允许 .. 路径穿越");
    if (
      process.platform === "win32" &&
      (/[<>:"|?*\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    )
      throw new Error("不允许 Windows 设备名、ADS 或非法路径");
  }
  return parts;
}
function bytesAt(dir: Directory, name: string, limit: number): { bytes: Buffer; info: fs.BigIntStats } {
  const initial = statAt(dir, name);
  if (!initial.isFile() || initial.size > BigInt(limit))
    throw new Error(`文件超过读取上限 (${limit} 字节)，或不是普通文件`);
  const fd = openAt(
    dir,
    name,
    fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = fs.fstatSync(fd, { bigint: true });
    if (!info.isFile() || signature(initial) !== signature(info))
      throw new Error("文件读取期间发生变化");
    const bytes = Buffer.alloc(Number(info.size) + 1);
    let used = 0;
    let count: number;
    while (
      (count = fs.readSync(fd, bytes, used, bytes.length - used, null)) > 0
    )
      used += count;
    if (
      used !== Number(info.size) ||
      signature(info) !== signature(fs.fstatSync(fd, { bigint: true }))
    )
      throw new Error("文件读取期间发生变化");
    return { bytes: bytes.subarray(0, used), info };
  } finally {
    fs.closeSync(fd);
  }
}
function textAt(dir: Directory, name: string, limit = LIMIT): TextRead {
  const { bytes, info } = bytesAt(dir, name, limit);
  if (bytes.some((value) => value < 32 && ![9, 10, 12, 13].includes(value)))
    throw new Error("二进制文件不能在文本编辑器中打开");
  return {
    text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    info,
  };
}

export class ProjectFiles {
  private constructor(
    readonly root: string,
    private identity: string,
  ) {}
  static async open(root: string): Promise<ProjectFiles> {
    root = await fs.promises.realpath(expand(root));
    const s = fs.statSync(root, { bigint: true });
    if (!s.isDirectory()) throw new Error("项目不是目录");
    return new ProjectFiles(root, `${s.dev}:${s.ino}`);
  }
  private directory<T>(parts: string[], fn: (dir: Directory) => T): T {
    const initial = fs.lstatSync(this.root, { bigint: true });
    if (isLink(this.root) || `${initial.dev}:${initial.ino}` !== this.identity)
      throw new Error("项目根目录发生变化，请重新打开");
    let current: Directory = {
      path: this.root,
      fd:
        process.platform === "win32"
          ? undefined
          : fs.openSync(
              this.root,
              fs.constants.O_RDONLY |
                fs.constants.O_DIRECTORY |
                fs.constants.O_NOFOLLOW,
            ),
    };
    try {
      if (current.fd !== undefined) {
        const s = fs.fstatSync(current.fd, { bigint: true });
        if (`${s.dev}:${s.ino}` !== this.identity)
          throw new Error("项目根目录发生变化");
      }
      for (const name of parts) {
        const next = childDirectory(current, name);
        closeDirectory(current);
        current = next;
      }
      return fn(current);
    } finally {
      closeDirectory(current);
    }
  }
  private parent<T>(value: string, fn: (dir: Directory, name: string) => T): T {
    const parts = relativeParts(value);
    const name = parts.pop();
    if (!name) throw new Error("不能修改项目根目录");
    return this.directory(parts, (dir) => fn(dir, name));
  }
  async entries(relative = "."): Promise<string[]> {
    return this.directory(relativeParts(relative), (dir) =>
      fs
        .readdirSync(dir.path)
        .flatMap((name) => {
          try {
            const s = statAt(dir, name);
            return s.isFile() || s.isDirectory()
              ? [{ name, directory: s.isDirectory() }]
              : [];
          } catch (error) {
            if (missing(error) || /链接|junction|reparse/.test(String(error)))
              return [];
            throw error;
          }
        })
        .sort(
          (a, b) =>
            Number(b.directory) - Number(a.directory) ||
            a.name.localeCompare(b.name),
        )
        .map((item) => path.join(dir.path, item.name)),
    );
  }
  async read(relative: string): Promise<string> {
    return this.parent(relative, textAt).text;
  }
  async readBytes(relative: string, limit: number): Promise<Buffer> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 * 1024 * 1024)
      throw new Error("二进制读取上限必须为 1–33554432 字节");
    return this.parent(relative, (dir, name) => bytesAt(dir, name, limit)).bytes;
  }
  async stat(relative: string): Promise<fs.BigIntStats> {
    return this.parent(relative, statAt);
  }
  async write(
    relative: string,
    text: string,
    expected?: string,
  ): Promise<void> {
    this.save(relative, text, expected, false);
  }
  async create(relative: string, text = ""): Promise<void> {
    this.save(relative, text, undefined, true);
  }
  private save(
    relative: string,
    text: string,
    expected: string | undefined,
    exclusive: boolean,
  ): void {
    const bytes = Buffer.from(text);
    if (bytes.length > LIMIT) throw new Error("文本文件最多 2 MiB");
    this.parent(relative, (dir, name) => {
      let previous: TextRead | undefined;
      try {
        previous = textAt(dir, name);
        if (exclusive) throw new Error("目标已存在，不覆盖");
        if (expected !== undefined && previous.text !== expected)
          throw new Error("文件已被外部修改，请重新加载");
      } catch (error) {
        if (!missing(error)) throw error;
        if (expected !== undefined) throw new Error("文件已被外部删除");
      }
      const temporary = ".lazyhb-" + randomUUID();
      const fd = openAt(
        dir,
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      );
      try {
        try {
          fs.writeFileSync(fd, bytes);
          if (previous) fs.fchmodSync(fd, Number(previous.info.mode & 0o777n));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        if (
          previous &&
          signature(statAt(dir, name)) !== signature(previous.info)
        )
          throw new Error("文件已被外部修改");
        renameAt(dir, temporary, dir, name, !!previous);
      } finally {
        try {
          unlinkAt(dir, temporary);
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
    });
  }
  async mkdir(relative: string): Promise<void> {
    this.parent(relative, mkdirAt);
  }
  async rename(source: string, target: string): Promise<void> {
    await this.move(source, target);
  }
  async move(source: string, target: string): Promise<void> {
    this.parent(source, (from, name) => {
      const info = statAt(from, name);
      if (!info.isDirectory() && !info.isFile())
        throw new Error("不允许特殊文件");
      this.parent(target, (to, newName) => renameAt(from, name, to, newName));
    });
  }
  async copy(source: string, target: string): Promise<void> {
    const a = relativeParts(source);
    const b = relativeParts(target);
    if (b.slice(0, a.length).join("/") === a.join("/"))
      throw new Error("不能复制到源目录内部");
    this.parent(source, (from, name) =>
      this.parent(target, (to, targetName) => {
        const stage = ".lazyhb-copy-" + randomUUID();
        const copy = (
          src: Directory,
          old: string,
          dst: Directory,
          next: string,
          depth: number,
        ): void => {
          if (depth > 64) throw new Error("目录层级超过 64");
          const s = statAt(src, old);
          if (s.isDirectory()) {
            mkdirAt(dst, next);
            const left = childDirectory(src, old);
            const right = childDirectory(dst, next);
            try {
              for (const entry of fs.readdirSync(left.path))
                copy(left, entry, right, entry, depth + 1);
            } finally {
              closeDirectory(left);
              closeDirectory(right);
            }
          } else if (s.isFile()) {
            const input = openAt(
              src,
              old,
              fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0),
            );
            let output: number | undefined;
            try {
              if (!fs.fstatSync(input).isFile())
                throw new Error("源文件类型已改变");
              output = openAt(
                dst,
                next,
                fs.constants.O_WRONLY |
                  fs.constants.O_CREAT |
                  fs.constants.O_EXCL,
                Number(s.mode & 0o777n),
              );
              const buffer = Buffer.alloc(64 * 1024);
              let count;
              while ((count = fs.readSync(input, buffer)) > 0) {
                let offset = 0;
                while (offset < count)
                  offset += fs.writeSync(
                    output,
                    buffer,
                    offset,
                    count - offset,
                  );
              }
              fs.fsyncSync(output);
            } finally {
              fs.closeSync(input);
              if (output !== undefined) fs.closeSync(output);
            }
          } else throw new Error("复制不允许设备或特殊文件");
        };
        try {
          copy(from, name, to, stage, 0);
          renameAt(to, stage, to, targetName);
        } finally {
          this.removeStage(to, stage);
        }
      }),
    );
  }
  private removeStage(dir: Directory, name: string): void {
    let info;
    try {
      info = statAt(dir, name);
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    if (info.isDirectory()) {
      const child = childDirectory(dir, name);
      try {
        for (const entry of fs.readdirSync(child.path))
          this.removeStage(child, entry);
      } finally {
        closeDirectory(child);
      }
      unlinkAt(dir, name, true);
    } else unlinkAt(dir, name);
  }
  async search(
    needle: string,
  ): Promise<{ path: string; line: number; text: string }[]> {
    if (!needle) throw new Error("请输入搜索文字");
    const result: { path: string; line: number; text: string }[] = [];
    let bytes = 0;
    let visited = 0;
    const visit = async (relative: string, depth: number): Promise<void> => {
      if (depth > 64) return;
      for (const filename of await this.entries(relative)) {
        if (
          ++visited > 20000 ||
          bytes >= 32 * 1024 * 1024 ||
          result.length >= 200
        )
          return;
        const name = path.basename(filename);
        const item = path.relative(this.root, filename);
        if (fs.lstatSync(filename).isDirectory()) {
          if (!Object.hasOwn(excluded, name)) await visit(item, depth + 1);
        } else {
          let text;
          try {
            text = this.parent(item, (dir, name) =>
              textAt(dir, name, Math.min(LIMIT, 32 * 1024 * 1024 - bytes)),
            ).text;
          } catch {
            continue;
          }
          bytes += Buffer.byteLength(text);
          const lines = text.split(/\r?\n/);
          for (
            let index = 0;
            index < lines.length && result.length < 200;
            index++
          )
            if (lines[index].includes(needle))
              result.push({
                path: item,
                line: index + 1,
                text: lines[index].slice(0, 300),
              });
        }
        if (visited % 64 === 0) await yieldTurn();
      }
    };
    await visit(".", 0);
    return result;
  }
}

export class ProjectRegistry {
  readonly stateDir: string;
  readonly path: string;
  constructor(stateDir?: string) {
    this.stateDir = stateDirectory(stateDir);
    this.path = path.join(this.stateDir, "projects.json");
  }
  async exists(): Promise<boolean> {
    try {
      await fs.promises.lstat(this.path);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }
  private async load(): Promise<{
    document: JsonDocument;
    projects: Project[];
  }> {
    const document = await JsonDocument.load(this.path);
    if (!(await this.exists())) return { document, projects: [] };
    if (
      document.get(["version"]) !== 1 ||
      !Array.isArray(document.get(["projects"]))
    )
      throw new Error("无效项目列表（需要 version 1）");
    const projects: Project[] = [];
    const seen = new Set<string>();
    for (const item of document.get(["projects"]) as unknown[]) {
      if (
        !item ||
        typeof item !== "object" ||
        !("path" in item) ||
        typeof item.path !== "string" ||
        !path.isAbsolute(item.path) ||
        !("alias" in item) ||
        typeof item.alias !== "string"
      )
        throw new Error("无效项目列表条目");
      const canonical = expand(item.path);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        projects.push({ path: canonical, alias: alias(item.alias) });
      }
    }
    return { document, projects };
  }
  async projects(): Promise<Project[]> {
    return (await this.load()).projects.sort(
      (a, b) =>
        projectName(a).localeCompare(projectName(b)) ||
        a.path.localeCompare(b.path),
    );
  }
  private async mutate(fn: (projects: Project[]) => void): Promise<void> {
    await fs.promises.mkdir(this.stateDir, { recursive: true });
    const lock = path.join(this.stateDir, "projects.lock");
    const deadline = Date.now() + 2000;
    while (true) {
      try {
        await fs.promises.mkdir(lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new Error(
            "项目列表被锁定；若上次异常退出，请确认没有其他 lazyhb 后移除 " +
              lock,
          );
        await delay(30);
      }
    }
    try {
      const { document, projects } = await this.load();
      fn(projects);
      document.set(["version"], 1);
      document.set(["projects"], projects);
      await document.save();
    } finally {
      await fs.promises.rmdir(lock);
    }
  }
  async add(filename: string, value = ""): Promise<Project> {
    filename = await fs.promises.realpath(expand(filename));
    if (!(await fs.promises.stat(filename)).isDirectory())
      throw new Error("项目不是目录");
    value = alias(value);
    let result!: Project;
    await this.mutate((items) => {
      const existing = items.find((item) => item.path === filename);
      if (existing) {
        if (value) existing.alias = value;
        result = existing;
      } else {
        result = { path: filename, alias: value };
        items.push(result);
      }
    });
    return result;
  }
  async remove(filename: string): Promise<void> {
    filename = expand(filename);
    await this.mutate((items) => {
      const index = items.findIndex((item) => item.path === filename);
      if (index >= 0) items.splice(index, 1);
    });
  }
  async alias(filename: string, value: string): Promise<void> {
    filename = expand(filename);
    value = alias(value);
    await this.mutate((items) => {
      const item = items.find((project) => project.path === filename);
      if (!item) throw new Error("项目未登记");
      item.alias = value;
    });
  }
}
export async function discoverProjects(): Promise<Project[]> {
  const home =
    (process.platform === "win32"
      ? process.env.USERPROFILE
      : process.env.HOME) ?? homedir();
  const bases =
    process.platform === "darwin"
      ? [path.join(home, "Library/Application Support")]
      : process.platform === "win32"
        ? [
            process.env.APPDATA ?? path.join(home, "AppData/Roaming"),
            process.env.LOCALAPPDATA ?? path.join(home, "AppData/Local"),
          ]
        : [process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")];
  const result = new Map<string, Project>();
  const decode = (value: string) =>
    value
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/\\(?:x([a-f\d]{1,4})|([nrt\\"]))/gi, (_, hex, escape) =>
        hex
          ? String.fromCharCode(parseInt(hex, 16))
          : (
              { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' } as Record<
                string,
                string
              >
            )[escape],
      );
  for (const base of bases)
    for (const folder of ["HBuilder X", "HBuilderX"])
      for (const file of ["HBuilder X.ini", "HBuilderX.ini"]) {
        const filename = path.join(base, folder, file);
        try {
          const s = await fs.promises.lstat(filename);
          if (isLink(filename, s) || s.size > LIMIT) continue;
          const text = await fs.promises.readFile(filename, "utf8");
          let workspace = false;
          const values = new Map<string, string>();
          for (const line of text.split(/\r?\n/)) {
            const section = /^\s*\[([^\]]+)\]/.exec(line);
            if (section) workspace = section[1].toLowerCase() === "workspace";
            else if (workspace) {
              const split = line.indexOf("=");
              if (split >= 0)
                values.set(
                  line.slice(0, split).trim().toLowerCase(),
                  line.slice(split + 1),
                );
            }
          }
          const count = Number(values.get("projects\\size") ?? 0);
          if (!Number.isInteger(count) || count < 0 || count > 10000) continue;
          for (let index = 1; index <= count; index++) {
            try {
              let item = decode(values.get(`projects\\${index}\\path`) ?? "");
              if (item.startsWith("file:")) {
                const url = new URL(item);
                if (
                  !["", "localhost"].includes(url.hostname) ||
                  url.search ||
                  url.hash
                )
                  continue;
                item = fileURLToPath(url);
              }
              if (
                !path.isAbsolute(item) ||
                !(await fs.promises.stat(item)).isDirectory()
              )
                continue;
              item = await fs.promises.realpath(item);
              if (!result.has(item))
                result.set(item, {
                  path: item,
                  alias: alias(
                    decode(values.get(`projects\\${index}\\alias`) ?? ""),
                  ),
                });
            } catch {
              /* stale or malformed entry */
            }
          }
        } catch (error) {
          if (
            !missing(error) &&
            !["EACCES", "EPERM"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw error;
        }
      }
  return [...result.values()].sort(
    (a, b) =>
      projectName(a).localeCompare(projectName(b)) ||
      a.path.localeCompare(b.path),
  );
}
