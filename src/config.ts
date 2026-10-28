import JSON5 from "json5";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { BigIntStats, Stats } from "node:fs";
export type ProjectKind = "uni-app" | "uni-app-x";
export type ManifestData = Record<string, unknown>;
interface Member {
  key: string;
  start: number;
  value: Span;
  comma?: number;
}
interface Span {
  start: number;
  end: number;
  members?: Member[];
}
const object = (value: unknown): value is ManifestData =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const absolute = (path: string): string =>
  resolve(
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? join(homedir(), path.slice(2))
        : path,
  );
function validatePath(path: string[]): void {
  if (!Array.isArray(path) || path.some((key) => typeof key !== "string"))
    throw new Error("A manifest path must be an array of string keys");
}
class Spans {
  constructor(private readonly text: string) {}
  trivia(index: number): number {
    while (index < this.text.length) {
      if (/\s/u.test(this.text[index]!)) index++;
      else if (this.text.startsWith("//", index)) {
        while (
          index < this.text.length &&
          !/[\r\n\u2028\u2029]/u.test(this.text[index]!)
        )
          index++;
      } else if (this.text.startsWith("/*", index)) {
        const end = this.text.indexOf("*/", index + 2);
        if (end < 0) throw new Error("Unterminated manifest comment");
        index = end + 2;
      } else break;
    }
    return index;
  }
  stringEnd(index: number): number {
    const quote = this.text[index++];
    while (index < this.text.length) {
      if (this.text[index] === "\\") index += 2;
      else if (this.text[index++] === quote) return index;
    }
    throw new Error("Unterminated manifest string");
  }
  node(index: number): Span {
    const text = this.text;
    const start = this.trivia(index);
    const char = text[start];
    if (char === undefined) throw new Error("Missing manifest value");
    if (char === '"' || char === "'")
      return { start, end: this.stringEnd(start) };
    if (char === "{") {
      const members: Member[] = [];
      const keys = new Set<string>();
      index = this.trivia(start + 1);
      while (text[index] !== "}") {
        const keyStart = index;
        let keyEnd = index;
        if (text[index] === '"' || text[index] === "'")
          keyEnd = this.stringEnd(index);
        else
          while (keyEnd < text.length && !/[\s:/]/u.test(text[keyEnd]!))
            keyEnd++;
        const key = Object.keys(
          JSON5.parse(
            "{" + text.slice(keyStart, keyEnd) + ":null}",
          ) as ManifestData,
        )[0];
        if (key === undefined || keys.has(key))
          throw new Error("Duplicate manifest key: " + key);
        keys.add(key);
        const colon = this.trivia(keyEnd);
        if (text[colon] !== ":")
          throw new Error("Missing colon after manifest key");
        const value = this.node(colon + 1);
        index = this.trivia(value.end);
        const member: Member = { key, start: keyStart, value };
        if (text[index] === ",") {
          member.comma = index;
          index = this.trivia(index + 1);
        } else if (text[index] !== "}")
          throw new Error("Missing comma between manifest fields");
        members.push(member);
      }
      return { start, end: index + 1, members };
    }
    if (char === "[") {
      index = this.trivia(start + 1);
      while (text[index] !== "]") {
        const value = this.node(index);
        index = this.trivia(value.end);
        if (text[index] === ",") index = this.trivia(index + 1);
        else if (text[index] !== "]")
          throw new Error("Missing comma between array elements");
      }
      return { start, end: index + 1 };
    }
    index = start;
    while (
      index < text.length &&
      !/[\s,\]}]/u.test(text[index]!) &&
      !text.startsWith("//", index) &&
      !text.startsWith("/*", index)
    )
      index++;
    return { start, end: index };
  }
}
function parse(text: string): { data: ManifestData; root: Span } {
  try {
    const data: unknown = JSON5.parse(text);
    if (!object(data))
      throw new Error("The manifest root must be a JSON object");
    return { data, root: new Spans(text).node(0) };
  } catch (cause) {
    throw new Error("Invalid manifest: " + String(cause), { cause });
  }
}
function signature(info: BigIntStats): string {
  return [
    info.dev,
    info.ino,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
    info.mode,
  ].join(":");
}
interface Disk {
  content: Buffer;
  fingerprint: string;
  mode: number;
}
async function readDisk(path: string): Promise<Disk | null> {
  let initial: BigIntStats;
  try {
    initial = await fs.lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (initial.isSymbolicLink())
    throw new Error("Refusing to replace a symbolic-link manifest: " + path);
  if (!initial.isFile())
    throw new Error("Manifest is not a regular file: " + path);
  const handle = await fs.open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await fs.lstat(path, { bigint: true });
    if (
      signature(initial) !== signature(before) ||
      signature(before) !== signature(after) ||
      signature(after) !== signature(current)
    )
      throw new Error("Manifest changed while reading; retry loading " + path);
    return {
      content,
      fingerprint:
        signature(after) +
        ":" +
        createHash("sha256").update(content).digest("hex"),
      mode: Number(after.mode) & 0o7777,
    };
  } finally {
    await handle.close();
  }
}
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function manifestPath(project: string): Promise<string> {
  project = absolute(project);
  const info = await lstatOrNull(project);
  if (basename(project) === "manifest.json" && info?.isSymbolicLink())
    throw new Error("Manifest must not be a symbolic link");
  if (basename(project) === "manifest.json" && info?.isFile()) return project;
  const canonical = await fs.realpath(project);
  const root = join(canonical, "manifest.json");
  if (await lstatOrNull(root)) return root;
  const source = join(canonical, "src");
  const sourceInfo = await lstatOrNull(source);
  if (sourceInfo?.isSymbolicLink())
    throw new Error(
      "Project src directory must not be a symbolic link or junction",
    );
  if (sourceInfo?.isDirectory()) {
    if ((await fs.realpath(source)) !== source)
      throw new Error("Manifest directory escapes project root");
    return join(source, "manifest.json");
  }
  return root;
}
export function projectKind(data: ManifestData): ProjectKind {
  return object(data["uni-app-x"]) ? "uni-app-x" : "uni-app";
}
export function pointer(path: string[]): string {
  validatePath(path);
  return (
    "/" +
    path
      .map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1"))
      .join("/")
  );
}
export function parsePointer(value: string): string[] {
  if (!value.startsWith("/") || value === "/")
    throw new Error(
      "请输入 JSON Pointer，例如 /app-plus/distribute/android/minSdkVersion",
    );
  return value
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}
function renderJSON(value: unknown, unit: string): string {
  const seen = new Set<object>();
  const validate = (item: unknown): void => {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return;
    if (
      typeof item !== "object" ||
      item === null ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    )
      throw new Error("Value is not valid JSON");
    if (seen.has(item))
      throw new Error("Value is not valid JSON: circular reference");
    seen.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(item))
      validate(child);
    seen.delete(item);
  };
  validate(value);
  return JSON.stringify(value, null, unit);
}
export class JsonDocument {
  readonly path: string;
  text: string;
  data: ManifestData;
  dirty = false;
  private root: Span;
  private savedText: string;
  private fingerprint: string | null;
  private readonly bom: boolean;
  private saving = false;
  private constructor(path: string, disk: Disk | null) {
    this.path = path;
    this.fingerprint = disk?.fingerprint ?? null;
    this.bom =
      disk?.content.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ??
      false;
    try {
      this.text = disk
        ? new TextDecoder("utf-8", { fatal: true }).decode(disk.content)
        : "{}\n";
    } catch (cause) {
      throw new Error("Manifest is not UTF-8: " + path, { cause });
    }
    const parsed = parse(this.text);
    this.data = parsed.data;
    this.root = parsed.root;
    this.savedText = this.text;
  }
  static async load(path: string): Promise<JsonDocument> {
    path = absolute(path);
    return new JsonDocument(path, await readDisk(path));
  }
  get(path: string[], fallback: unknown = null): unknown {
    validatePath(path);
    let value: unknown = this.data;
    for (const key of path) {
      if (!object(value) || !Object.hasOwn(value, key)) return fallback;
      value = value[key];
    }
    return value;
  }
  private accept(text: string): void {
    const parsed = parse(text);
    this.text = text;
    this.data = parsed.data;
    this.root = parsed.root;
    this.dirty = text !== this.savedText;
  }
  replaceSource(text: string): void {
    if (typeof text !== "string")
      throw new Error("Manifest source must be text");
    this.accept(text);
  }
  private indent(node: Span): [string, string] {
    const line = this.text.lastIndexOf("\n", node.start - 1) + 1;
    const base = /^[\t ]*/.exec(this.text.slice(line, node.start))![0];
    for (const member of node.members ?? []) {
      const line = this.text.lastIndexOf("\n", member.start - 1) + 1;
      const prefix = this.text.slice(line, member.start);
      if (
        !prefix.trim() &&
        prefix.startsWith(base) &&
        prefix.length > base.length
      )
        return [base, prefix.slice(base.length)];
    }
    return [base, /\n([\t ]+)["'\w]/.exec(this.text)?.[1] ?? "  "];
  }
  private render(value: unknown, node: Span): string {
    const [base, unit] = this.indent(node);
    return renderJSON(value, unit).replaceAll(
      "\n",
      (this.text.includes("\r\n") ? "\r\n" : "\n") + base,
    );
  }
  set(path: string[], value: unknown): void {
    validatePath(path);
    if (!path.length) {
      if (!object(value))
        throw new Error("The manifest root must remain an object");
      this.accept(
        this.text.slice(0, this.root.start) +
          this.render(value, this.root) +
          this.text.slice(this.root.end),
      );
      return;
    }
    let node = this.root;
    for (const [depth, key] of path.entries()) {
      if (!node.members)
        throw new Error(
          "Cannot create a child under non-object field " +
            (path.slice(0, depth).join(".") || "<root>") +
            "; edit that value explicitly first",
        );
      const member = node.members.find((item) => item.key === key);
      if (!member) {
        let nested = value;
        for (const remaining of path.slice(depth + 1).reverse())
          nested = { [remaining]: nested };
        this.insert(node, key, nested);
        return;
      }
      if (depth === path.length - 1) {
        this.accept(
          this.text.slice(0, member.value.start) +
            this.render(value, member.value) +
            this.text.slice(member.value.end),
        );
        return;
      }
      node = member.value;
    }
  }
  private insert(node: Span, key: string, value: unknown): void {
    const text = this.text;
    const members = node.members ?? [];
    const [base, unit] = this.indent(node);
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const rendered = renderJSON(value, unit).replaceAll(
      "\n",
      newline + base + unit,
    );
    const close = node.end - 1;
    const line = text.lastIndexOf("\n", close - 1) + 1;
    const trailing = members.at(-1)?.comma !== undefined;
    let position: number;
    let addition: string;
    if (text.slice(node.start, node.end).includes("\n")) {
      position = !text.slice(line, close).trim() ? line : close;
      addition =
        (position === line ? "" : newline) +
        base +
        unit +
        JSON.stringify(key) +
        ": " +
        rendered +
        (trailing ? "," : "") +
        newline +
        (position === close ? base : "");
    } else {
      position = close;
      addition =
        (members.length || text.slice(node.start + 1, close) ? " " : "") +
        JSON.stringify(key) +
        ": " +
        rendered +
        (trailing ? "," : "");
    }
    let updated = text.slice(0, position) + addition + text.slice(position);
    const last = members.at(-1);
    if (last && !trailing)
      updated =
        updated.slice(0, last.value.end) + "," + updated.slice(last.value.end);
    this.accept(updated);
  }
  delete(path: string[]): void {
    validatePath(path);
    if (!path.length)
      throw new Error(
        "Cannot delete the manifest root; replace it with an object instead",
      );
    let node = this.root;
    for (const [depth, key] of path.entries()) {
      const members = node.members;
      if (!members) return;
      const index = members.findIndex((item) => item.key === key);
      const member = members[index];
      if (!member) return;
      if (depth !== path.length - 1) {
        node = member.value;
        continue;
      }
      const edits: [number, number][] = [[member.start, member.value.end]];
      const comma = member.comma ?? members[index - 1]?.comma;
      if (comma !== undefined) edits.push([comma, comma + 1]);
      let text = this.text;
      for (const [start, end] of edits.sort((a, b) => b[0] - a[0]))
        text = text.slice(0, start) + text.slice(end);
      this.accept(text);
      return;
    }
  }
  private async checkExternal(): Promise<Disk | null> {
    const disk = await readDisk(this.path);
    if ((disk?.fingerprint ?? null) !== this.fingerprint)
      throw new Error(
        "Manifest changed externally; reload before saving: " + this.path,
      );
    return disk;
  }
  async save(): Promise<void> {
    if (this.saving) throw new Error("A manifest save is already in progress");
    this.saving = true;
    let temporary: string | undefined;
    try {
      const disk = await this.checkExternal();
      if (!this.dirty && this.fingerprint !== null) return;
      const source = this.text;
      parse(source);
      const content = Buffer.concat([
        this.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0),
        Buffer.from(source, "utf8"),
      ]);
      temporary = join(
        dirname(this.path),
        "." + basename(this.path) + "." + randomUUID() + ".tmp",
      );
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        if (disk) await handle.chmod(disk.mode);
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.checkExternal();
      if (this.fingerprint === null) {
        await fs.link(temporary, this.path);
        await fs.unlink(temporary);
      } else await fs.rename(temporary, this.path);
      temporary = undefined;
      const saved = await readDisk(this.path);
      if (!saved || !saved.content.equals(content))
        throw new Error(
          "Manifest changed immediately after saving; reload " + this.path,
        );
      this.fingerprint = saved.fingerprint;
      this.savedText = source;
      this.dirty = this.text !== source;
      if (process.platform !== "win32") {
        const directory = await fs.open(
          dirname(this.path),
          constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
        );
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      this.saving = false;
      if (temporary)
        await fs.unlink(temporary).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
    }
  }
}
