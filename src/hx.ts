import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
/** Normalize terminal sequences before credential matching, including split CSI/OSC. */
function terminalText(): (text: string) => string {
  let state = "";
  return (text) => {
    if (!state && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(text)) return text;
    let result = "";
    for (const character of text) {
      const code = character.charCodeAt(0);
      if (state === "escape") {
        state =
          character === "["
            ? "csi"
            : "]P^_X".includes(character)
              ? "string"
              : code >= 0x20 && code <= 0x2f
                ? "intermediate"
                : "";
      } else if (state === "csi") {
        if (code >= 0x40 && code <= 0x7e) state = "";
      } else if (state === "intermediate") {
        if (code >= 0x30 && code <= 0x7e) state = "";
      } else if (state === "string") {
        if (character === "\x07") state = "";
        else if (character === "\x1b") state = "string-escape";
      } else if (state === "string-escape") {
        state =
          character === "\\"
            ? ""
            : character === "\x1b"
              ? "string-escape"
              : "string";
      } else if (character === "\x1b") state = "escape";
      else if (
        character === "\n" ||
        character === "\t" ||
        (code >= 32 && !(code >= 127 && code <= 159))
      )
        result += character;
    }
    return result;
  };
}

async function packConfiguration(filename: string): Promise<unknown> {
  const initial = await fs.lstat(filename, { bigint: true });
  if (initial.isSymbolicLink() || !initial.isFile())
    throw new Error("打包配置必须是非链接的普通文件");
  const handle = await fs.open(
    filename,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("打包配置必须是普通文件");
    if (before.dev !== initial.dev || before.ino !== initial.ino)
      throw new Error("打包配置读取期间发生变化");
    if (before.size > 2n * 1024n * 1024n) throw new Error("打包配置超过 2 MiB");
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      BigInt(length) !== before.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("打包配置读取期间发生变化");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, length),
        ),
      );
    } catch {
      // SyntaxError snippets can contain passwords from the supplied file.
      throw new Error("打包配置必须是有效 UTF-8 JSON，未执行命令");
    }
  } finally {
    await handle.close();
  }
}

export interface Parameter {
  name: string;
  description: string;
  required: boolean;
  choices: string[];
  default?: string;
}
export interface Command {
  name: string;
  description: string;
  parameters: Parameter[];
}
const secret = /password|secret|token|privatekey|username/i;
const blocked: Record<string, true> = {
  open: true,
  "open file": true,
  "app quit": true,
  update: true,
  "report-bug": true,
  "user login": true,
};
export function parseHelp(text: string): Command[] {
  const records = new Map<string, Command>();
  let current: Command | undefined;
  let last = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^[A-Za-z_][A-Za-z0-9_.-]*(?: [A-Za-z0-9_.-]+)*\s*$/.test(line)) {
      const name = line.trim();
      current = records.get(name) ?? { name, description: "", parameters: [] };
      records.set(name, current);
      last = false;
      continue;
    }
    if (!current) continue;
    const match = /^\s+--([\w.-]+)\s*(?:\t| {2,})(.*)/.exec(line);
    if (match) {
      const [, name, description] = match;
      const previous = current.parameters.find((item) => item.name === name);
      const choices = [
        ...new Set([
          ...(previous?.choices ?? []),
          ...[...description.matchAll(/取值有\[([^\]]+)\]/g)].flatMap((item) =>
            item[1]
              .split("|")
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        ]),
      ];
      // Installed help also describes fixed product types outside enum brackets.
      if (name === "type")
        for (const fixed of description.matchAll(/固定为\s+([\w-]+)/g))
          if (!choices.includes(fixed[1])) choices.push(fixed[1]);
      const optional = /可选值[：:]\s*([^；;。（(]+)/.exec(description)?.[1];
      if (optional && !/多个|英文逗号/.test(description) && !/\d+\s+\S/.test(optional))
        for (const value of optional.split(/[、,，|]/).map((value) => value.trim()))
          if (/^[\w-]+$/.test(value) && !choices.includes(value)) choices.push(value);
      const parameter: Parameter = {
        name,
        description:
          previous && !previous.description.includes(description)
            ? previous.description + " / " + description
            : description,
        choices,
        required:
          /必填/.test(description) && !/时必填|时.*必填|仅.*必填/.test(description),
        default:
          /默认值为[:：]\s*([^\s，。；]+)/.exec(description)?.[1] ??
          previous?.default,
      };
      if (previous) Object.assign(previous, parameter);
      else current.parameters.push(parameter);
      last = true;
    } else if (
      line.trim() &&
      !last &&
      !/^(参数|用法|cli |\.\/|说明)/.test(line.trim())
    )
      current.description = (current.description + " " + line.trim()).trim();
  }
  return [...records.values()].filter(
    (item) => !Object.hasOwn(blocked, item.name),
  );
}
export async function executable(explicit?: string, useEnvironment = true): Promise<string> {
  const value = explicit ?? (useEnvironment ? process.env.HX_CLI : undefined);
  if (value !== undefined && !value.trim())
    throw new Error("HBuilderX CLI 路径不能为空。");
  const expanded = value?.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : value === "~" ? homedir() : value;
  const pathCandidates = (name: string): string[] =>
    (process.env.PATH ?? "").split(delimiter).map((base) =>
      join(base, process.platform === "win32" && !/\.[^\\/]+$/.test(name)
        ? name + ".exe"
        : name),
    );
  const candidates = expanded !== undefined
    ? isAbsolute(expanded) || /[\\/]/.test(expanded)
      ? [expanded]
      : pathCandidates(expanded)
    : [
        ...(process.platform === "win32"
          ? [process.env.ProgramFiles, process.env.LOCALAPPDATA, process.env["ProgramFiles(x86)"]]
              .filter((v): v is string => !!v)
              .map(base => join(base, "HBuilderX", "cli.exe"))
          : [
              "/Applications/HBuilderX.app/Contents/MacOS/cli",
              join(homedir(), "Applications/HBuilderX.app/Contents/MacOS/cli"),
              join(homedir(), "HBuilderX/cli"),
              "/opt/HBuilderX/cli",
            ]),
        ...pathCandidates("cli"),
      ];
  for (const candidate of candidates) {
    // Batch scripts require a shell; HXClient deliberately uses shell:false.
    if (process.platform === "win32" && /\.(?:bat|cmd)$/i.test(candidate)) continue;
    try {
      if ((await fs.stat(candidate)).isFile()) {
        await fs.access(
          candidate,
          process.platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        return resolve(candidate);
      }
    } catch {
      /* try next installed location */
    }
  }
  throw new Error(
    value !== undefined
      ? `指定的 HBuilderX CLI 不可执行或不存在：${value}。不会回退到其它版本。`
      : "未找到 HBuilderX CLI。使用 --cli 或 HX_CLI 指定；不会自动安装或打开 IDE。",
  );
}
export class CLICancelledError extends Error {
  constructor() { super("本地 CLI 任务已取消"); this.name = "CLICancelledError"; }
}
export class HXClient {
  private process?: ChildProcess;
  private busy = false;
  private cancelRequested = false;
  private cancellation?: Promise<void>;
  private stopping?: Promise<void>;
  private completion?: { promise: Promise<void>; resolve: () => void };
  private commands = new Map<string, Command>();
  constructor(
    public readonly executable: string,
    private options: { argumentPrefix?: string[] } = {},
  ) {}
  get running(): boolean {
    return this.busy;
  }
  private beginInvocation(): void {
    if (this.busy) throw new Error("已有 CLI 调用进行中");
    this.busy = true;
    this.cancelRequested = false;
    this.completion = Promise.withResolvers<void>();
  }
  private finishInvocation(): void {
    this.busy = false;
    this.completion?.resolve();
    this.completion = undefined;
  }
  private async execute(
    args: string[],
    onLine: (line: string) => void,
    limit?: number,
    secrets: readonly string[] = [],
    reserved = false,
  ): Promise<number> {
    if (!reserved) this.beginInvocation();
    if (this.cancelRequested) throw new CLICancelledError();
    let child: ChildProcess;
    try {
      child = spawn(
        this.executable,
        [...(this.options.argumentPrefix ?? []), ...args],
        {
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (cause) {
      if (!reserved) this.finishInvocation();
      throw cause;
    }
    this.process = child;
    let size = 0;
    let overflow = false;
    const consume = (stream: NodeJS.ReadableStream) => {
      const decoder = new StringDecoder("utf8");
      const normalize = terminalText();
      let pending = "";
      let carry = "";
      const emit = (data: string) => {
        pending += data;
        while (pending.includes("\n")) {
          const end = pending.indexOf("\n");
          onLine(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
        if (pending.length > 65536) {
          onLine(pending);
          pending = "";
        }
      };
      const redact = (data: string, final = false) => {
        carry += data;
        for (const value of secrets)
          carry = carry.replaceAll(value, "[已隐藏]");
        // Hold only a suffix that could complete a credential in the next read.
        let keep = 0;
        if (!final)
          for (const value of secrets) {
            let index = carry.indexOf(
              value[0],
              Math.max(0, carry.length - value.length + 1),
            );
            while (index >= 0) {
              if (value.startsWith(carry.slice(index))) {
                keep = Math.max(keep, carry.length - index);
                break;
              }
              index = carry.indexOf(value[0], index + 1);
            }
          }
        emit(carry.slice(0, carry.length - keep));
        carry = keep ? carry.slice(-keep) : "";
      };
      stream.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (limit && size > limit) {
          overflow = true;
          void this.cancel();
          return;
        }
        redact(normalize(decoder.write(chunk)));
      });
      stream.on("end", () => {
        redact(normalize(decoder.end()), true);
        if (pending) onLine(pending);
      });
    };
    consume(child.stdout!);
    consume(child.stderr!);
    try {
      const [exitCode, signal] = await once(child, "close");
      const code = exitCode ?? (signal ? 130 : 1);
      if (overflow) throw new Error("CLI 输出超过 4 MiB，已终止");
      if (this.cancelRequested) throw new CLICancelledError();
      return code;
    } finally {
      // A parent can close before its children. Do not release the slot until
      // the shared cancellation has finished cleaning the entire process tree.
      try { await this.cancellation; }
      finally {
        if (this.process === child) this.process = undefined;
        if (!reserved) this.finishInvocation();
      }
    }
  }
  private async capture(args: string[]): Promise<string> {
    const lines: string[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      if (this.cancelRequested) return;
      timedOut = true;
      void this.cancel();
    }, 20000);
    try {
      const code = await this.execute(
        args,
        (line) => lines.push(line),
        4 * 1024 * 1024,
      );
      if (timedOut)
        throw new Error("CLI 响应超时；检查后台状态，不会自动启动 IDE。");
      if (code)
        throw new Error(`CLI 返回 ${code}: ${lines.join("\n").slice(0, 2000)}`);
      return lines.join("\n");
    } catch (error) {
      if (timedOut && error instanceof CLICancelledError)
        throw new Error("CLI 响应超时；检查后台状态，不会自动启动 IDE。");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async discover(): Promise<Command[]> {
    const text = await this.capture(["--help"]);
    const commands = parseHelp(text);
    if (
      !text.includes("HBuilderX") ||
      !commands.some((item) => item.name === "project list")
    )
      throw new Error(
        "CLI 未提供可用能力；HBuilderX 后台可能未运行。\n" +
          text.slice(0, 1000),
      );
    this.commands = new Map(commands.map((item) => [item.name, item]));
    return commands;
  }
  async version(): Promise<string> {
    return this.capture(["version"]);
  }
  async projects(): Promise<string[]> {
    return (await this.capture(["project", "list"]))
      .split("\n")
      .flatMap((line) => /^\d+\s*-\s*(.+)/.exec(line)?.slice(1) ?? []);
  }
  arguments(
    command: Command | string,
    parameters: Record<string, string>,
    allowSensitive = false,
  ): string[] {
    const name = typeof command === "string" ? command : command.name;
    if (Object.hasOwn(blocked, name) || /^(open |app )/.test(name))
      throw new Error("禁止打开/退出/更新图形 IDE 或未接入流程");
    const known = this.commands.get(name);
    if (!known) throw new Error("命令不在已发现的 CLI 能力中，请先连接 / 刷新");
    const supported = new Map(
      known.parameters.map((item) => [item.name, item]),
    );
    for (const [key, value] of Object.entries(parameters)) {
      const param = supported.get(key);
      if (!param) throw new Error(`此版本不支持 --${key}`);
      if (typeof value !== "string" || value.includes("\0"))
        throw new Error("CLI 参数必须为不含 NUL 的字符串");
      if (
        value !== "@flag" &&
        param.choices.length &&
        !param.choices.includes(value)
      )
        throw new Error(`--${key} 必须是 ${param.choices.join(" / ")}`);
    }
    const legacyNonApp = name === "publish" && ["web", "h5", "mp-weixin", "mp-alipay"].includes(parameters.platform?.toLowerCase()) &&
      supported.get("platform")?.choices.includes(parameters.platform);
    for (const param of known.parameters)
      if (param.required && !(name === "pack" && parameters.config && param.name !== "config") && !(legacyNonApp && param.name === "type") && !parameters[param.name])
        throw new Error(`缺少参数 --${param.name}`);
    if (!["false", "0"].includes((parameters.ui ?? "false").toLowerCase()))
      throw new Error("禁止 --ui true");
    if (name.startsWith("launch ")) {
      if (!supported.has("ui"))
        throw new Error("此 CLI 未暴露纯命令行运行模式");
      const target = name.split(" ")[1];
      if (
        (target === "web" ||
          (/^(mp-|quickapp-)/.test(target) && target !== "mp-harmony")) &&
        parameters.compile?.toLowerCase() !== "true"
      )
        throw new Error("此目标只支持 --compile true（仅编译）");
      if (target === "app-ios" && parameters.iosTarget === "simulator")
        throw new Error("禁止启动 iOS 图形模拟器");
    }
    if (
      !allowSensitive &&
      Object.keys(parameters).some((key) => secret.test(key))
    )
      throw new Error("凭据操作需要显式确认");
    const confidential =
      Object.keys(parameters).some(
        (key) =>
          /password|secret|token/i.test(key) ||
          supported.get(key)?.description.includes("密码"),
      ) ||
      (name === "config set" && secret.test(parameters.key ?? ""));
    if (confidential && (name !== "pack" || !supported.has("config")))
      throw new Error("此版本只能经 argv 传递凭据，暂不执行；使用已有登录态或支持私有 JSON 的云打包 CLI");
    if (
      name === "pack" &&
      "config" in parameters &&
      Object.keys(parameters).length !== 1
    )
      throw new Error("云打包 --config 不能与其他参数混用");
    return [
      ...name.split(" "),
      ...Object.entries(parameters).flatMap(([key, value]) =>
        value === "@flag" ? ["--" + key] : ["--" + key, value],
      ),
    ];
  }
  async preparePackConfiguration(filename: string, project: string): Promise<Record<string, unknown>> {
    if (!isAbsolute(filename)) throw new Error("云打包 JSON 必须使用绝对路径");
    const settings = await packConfiguration(filename);
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      throw new Error("打包配置根节点必须是对象");
    const result = settings as Record<string, unknown>;
    if (!isAbsolute(project) || result.project !== project)
      throw new Error("云打包 JSON 的 project 必须与捕获的项目绝对路径完全一致；不会使用 IDE 当前项目");
    for (const parameter of this.commands.get("pack")?.parameters ?? []) {
      if (!parameter.required || parameter.name === "config") continue;
      let value: unknown = result;
      for (const part of parameter.name.split("."))
        value = value && typeof value === "object" ? (value as Record<string, unknown>)[part === "storepassword" ? "storePassword" : part] : undefined;
      if (value === undefined || value === null || value === "") throw new Error(`云打包 JSON 缺少必填字段 ${parameter.name}`);
    }
    return result;
  }
  async run(
    command: Command | string,
    parameters: Record<string, string>,
    onLine: (line: string) => void,
    options: { allowSensitive?: boolean; packConfiguration?: Record<string, unknown>; project?: string } = {},
  ): Promise<number> {
    const name = typeof command === "string" ? command : command.name;
    this.beginInvocation();
    let temporary: string | undefined;
    try {
      let args = this.arguments(command, parameters, options.allowSensitive);
      const secrets = Object.entries(parameters)
        .filter(([key, value]) => secret.test(key) && value !== "@flag")
        .map(([, value]) => value)
        .filter(Boolean);
      if (name === "pack" && !("help" in parameters) && this.commands.get(name)?.parameters.some((parameter) => parameter.name === "config")) {
        if (parameters.config) {
          const filename = isAbsolute(parameters.config)
            ? parameters.config
            : resolve(parameters.config);
          const settings = options.packConfiguration ?? await packConfiguration(filename);
          if (
            !settings ||
            typeof settings !== "object" ||
            Array.isArray(settings)
          )
            throw new Error("打包配置根节点必须是对象");
          if (options.packConfiguration && (!options.project || (settings as Record<string, unknown>).project !== options.project))
            throw new Error("云打包配置快照的项目绑定无效");
          const collect = (value: unknown) => {
            if (value && typeof value === "object")
              for (const [key, child] of Object.entries(value)) {
                if (secret.test(key) && typeof child === "string" && child)
                  secrets.push(child);
                else collect(child);
              }
          };
          collect(settings);
          temporary = await fs.mkdtemp(join(tmpdir(), "lazyhb-pack-"));
          await fs.chmod(temporary, 0o700);
          const snapshot = join(temporary, "configure.json");
          await fs.writeFile(snapshot, JSON.stringify(settings), { mode: 0o600, flag: "wx" });
          args = ["pack", "--config", snapshot];
        } else {
          const settings: Record<string, unknown> = {};
          const known = this.commands.get(name)!;
          for (const [key, value] of Object.entries(parameters)) {
            const parts = key.split(".");
            if (key === "android.storepassword") parts[1] = "storePassword";
            let target = settings;
            for (const part of parts.slice(0, -1)) {
              if (["__proto__", "constructor", "prototype"].includes(part))
                throw new Error("无效打包字段");
              if (target[part] === undefined) target[part] = {};
              if (!target[part] || typeof target[part] !== "object")
                throw new Error("打包字段冲突");
              target = target[part] as Record<string, unknown>;
            }
            const leaf = parts.at(-1)!;
            if (["__proto__", "constructor", "prototype"].includes(leaf))
              throw new Error("无效打包字段");
            const choices =
              known.parameters.find((item) => item.name === key)?.choices ?? [];
            target[leaf] =
              value === "@flag"
                ? true
                : choices.length === 2 &&
                    choices.includes("true") &&
                    choices.includes("false")
                  ? value === "true"
                  : value;
          }
          temporary = await fs.mkdtemp(join(tmpdir(), "lazyhb-pack-"));
          await fs.chmod(temporary, 0o700);
          const filename = join(temporary, "configure.json");
          await fs.writeFile(filename, JSON.stringify(settings), {
            mode: 0o600,
            flag: "wx",
          });
          args = ["pack", "--config", filename];
        }
      }
      const count = secrets.length;
      for (let index = 0; index < count; index++) {
        const normalized = terminalText()(secrets[index]);
        if (normalized && normalized !== secrets[index])
          secrets.push(normalized);
      }
      secrets.sort((a, b) => b.length - a.length);
      return await this.execute(args, onLine, undefined, secrets, true);
    } finally {
      try { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
      finally { this.finishInvocation(); }
    }
  }
  cancel(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.busy) return Promise.resolve();
    const child = this.process;
    // Do not relabel a failure which had already exited before Stop arrived.
    if (child && (child.exitCode !== null || child.signalCode !== null))
      return Promise.resolve();
    this.cancelRequested = true;
    if (!child?.pid) return this.completion!.promise;
    const operation = this.terminateTree(child);
    const tree = operation.finally(() => {
      if (this.cancellation === tree) this.cancellation = undefined;
    });
    this.cancellation = tree;
    const shared = Promise.all([tree, this.completion!.promise]).then(() => {}).finally(() => {
      if (this.stopping === shared) this.stopping = undefined;
    });
    this.stopping = shared;
    return shared;
  }
  private async terminateTree(child: ChildProcess): Promise<void> {
    const pid = child.pid!;
    const closed =
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : once(child, "close").then(() => {});
    if (process.platform === "win32") {
      const killer = spawn(
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(pid), "/T", "/F"],
        { shell: false, windowsHide: true, stdio: "ignore" },
      );
      const [code] = await once(killer, "close");
      if (code && child.exitCode === null && child.signalCode === null)
        throw new Error(`无法终止 CLI 进程树（taskkill ${code}）`);
    } else {
      const signal = (value: NodeJS.Signals | 0): boolean => {
        try {
          process.kill(-pid, value);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          throw error;
        }
      };
      if (signal("SIGTERM")) {
        const deadline = Date.now() + 3000;
        while (signal(0) && Date.now() < deadline) await delay(30);
        signal("SIGKILL");
      }
    }
    await closed;
  }
}
