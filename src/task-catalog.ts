import type { Command, Parameter } from "./hx.js";

export type TaskKind = "run" | "publish";
export type TaskMode = "run" | "compile" | "publish" | "manage";
export interface TaskChoice {
  id: string;
  target: string;
  command: Command;
  label: string;
  description: string;
  mode: TaskMode;
  defaults: Record<string, string>;
  projectParameter?: string;
  unavailable?: string;
  artifact: string;
  prerequisites: string;
  risk: string;
}
const projectKeys = ["project", "projectPath", "prj"];
export const parameterSupports = (command: Command, name: string, value: string) => {
  const parameter = command.parameters.find((item) => item.name === name);
  return !!parameter && (parameter.choices.length ? parameter.choices.includes(value) : name !== "type" || new RegExp(`\\b${value}\\b`).test(parameter.description));
};

/** Product modes are distinct even when the installed CLI uses a single command. */
export function taskChoices(commands: readonly Command[], kind: TaskKind, projectType?: "uni-app" | "uni-app-x"): TaskChoice[] {
  const choices: TaskChoice[] = [];
  const legacyTargets = ["app", "app-android", "app-ios", "app-harmony", "web", "mp-weixin", "mp-alipay"];
  const candidates = commands.flatMap<{ command: Command; platform?: string }>((command) => command.name === "publish"
    ? (command.parameters.find((parameter) => parameter.name === "platform")?.choices.length
      ? command.parameters.find((parameter) => parameter.name === "platform")!.choices.map((platform) => ({ command, platform }))
      : [{ command, platform: "" }])
    : [{ command, platform: undefined }]);
  for (const { command, platform } of candidates) {
    const [family, commandTarget = family === "pack" ? "App 云打包" : "旧版 publish", extra] = command.name.split(" ");
    if (extra) continue;
    const target = platform ? platform.toLowerCase() === "h5" ? "web" : platform.toLowerCase() : commandTarget;
    const has = (key: string) => command.parameters.some((parameter) => parameter.name === key);
    const supports = (key: string, value: string) => parameterSupports(command, key, value);
    const add = (suffix: string, label: string, mode: TaskMode, defaults: Record<string, string>, artifact: string, prerequisites: string, risk = "本地操作；不上传云端", unavailable?: string) => {
      const typeRestriction = projectType === "uni-app-x" && (/^quickapp-/.test(target) || /^mp-/.test(target) && target !== "mp-weixin")
        ? "此平台官方仅支持 classic uni-app，不适用于当前 uni-app x 项目" : undefined;
      const legacyGap = command.name === "publish" && (!platform || !legacyTargets.includes(target))
        ? "旧版 publish 未提供可核实的已文档化 platform 枚举值；请使用高级 CLI 或切换版本" : undefined;
      choices.push({ id: `${command.name}${platform ? ":" + target : ""}:${suffix}`, target, command, label, mode, defaults: { ...(platform ? { platform } : {}), ...defaults }, artifact, prerequisites, risk, unavailable: unavailable ?? typeRestriction ?? legacyGap,
        description: unavailable ?? typeRestriction ?? legacyGap ?? `${artifact}；${prerequisites}`,
        projectParameter: projectKeys.find(has) });
    };
    if (kind === "run") {
      if (family !== "launch") continue;
      const ui = ["false", "0"].find((value) => command.parameters.find((parameter) => parameter.name === "ui")?.choices.includes(value));
      const native = ["app-android", "app-ios", "app-harmony", "mp-harmony"].includes(target);
      const base: Record<string, string> = ui ? { ui } : {};
      const prerequisites = target === "app-ios" ? "连接 iPhone 真机、iOS 运行组件；UTS 开发证书凭据若需 argv 密码则安全策略拒绝"
        : native ? "连接设备并安装平台 CLI 工具链；自定义基座须预先云打包"
          : target === "web" ? "安装 Web 编译组件与所选浏览器；多个项目启动前分别配置开发端口"
            : "安装对应编译组件；实际运行需要浏览器或开发者工具";
      if (native) add("run", "设备运行", "run", { ...base, ...(has("compile") ? { compile: "false" } : {}), ...(target === "app-ios" && has("iosTarget") ? { iosTarget: "device" } : {}) }, "编译、安装并启动所选设备应用", prerequisites, "会部署到设备；不启动 IDE 或图形模拟器",
        !ui ? "当前 CLI 未提供可核实的 ui=false 纯 CLI 模式" : has("compile") && !supports("compile", "false") ? "当前 CLI 只支持编译" : target === "app-ios" && has("iosTarget") && !supports("iosTarget", "device") ? "当前 CLI 不支持 iPhone 真机模式" : undefined);
      else if (target === "web") add("run", "Web 开发运行", "run", { ...base, compile: "false" }, "Web 开发服务并在浏览器中运行", prerequisites, "会启动浏览器；不启动图形 IDE；不同项目避免端口冲突，同项目并发可能争用编译目录",
        !ui ? "当前 CLI 未提供可核实的 ui=false / 0 纯 CLI 模式" : !command.parameters.find((parameter) => parameter.name === "compile")?.choices.includes("false") ? "当前 CLI 未明确支持 compile=false Web 运行；请选择受支持的仅编译模式" : undefined);
      else add("external", ["mp-", "quickapp-"].some((prefix) => target.startsWith(prefix)) ? "实际运行（外部 GUI 缺口）" : "实际运行（能力未核实）", "run", {}, "实际目标运行（未执行）", prerequisites, "不执行", /^(?:mp-|quickapp-)/.test(target) ? "实际运行依赖外部开发者工具或模拟器，不符合当前授权范围；请选择仅编译" : "此 launch 目标的运行语义尚未核实，不推断其无 GUI 安全性；可查看高级 CLI help");
      if (ui && (target === "web" ? command.parameters.find((parameter) => parameter.name === "compile")?.choices.includes("true") : supports("compile", "true"))) add("compile", "仅编译", "compile", { ...base, compile: "true", ...(target === "app-ios" && has("iosTarget") && supports("iosTarget", "device") ? { iosTarget: "device" } : {}) }, "开发编译结果（不是设备运行，也不是发行安装包）", "需要平台编译组件；不启动目标应用或外部 GUI");
      continue;
    }
    if (family === "publish") {
      if (has("type") && (command.name !== "publish" || /^app(?:-|$)/.test(target))) {
        for (const type of ["appResource", "wgt"]) if (supports("type", type)) add(type, type === "wgt" ? "制作 WGT 更新包" : "生成本地打包 App 资源", "publish", { type }, type === "wgt" ? "WGT 热更新资源包（不是 APK / IPA / 鸿蒙安装包）；path 是导出目录，默认 unpackage/release" : "原生工程打包资源（不是最终 APK / IPA / 鸿蒙安装包）", "需要平台编译组件；最终原生安装包需另行对应工具链构建");
      } else if (target === "web") {
        add("web", "网站发行 · 仅编译", "publish", has("webHosting") ? { webHosting: "false" } : {}, "Web 生产静态文件或 SSR 编译产物；不启动浏览器", "SSR 仅 Vue3；部署环境由使用者配置", "本地编译；不上传云端", has("webHosting") && !supports("webHosting", "false") ? "当前 CLI 不接受 webHosting=false，无法保证本地编译模式" : undefined);
        if (supports("webHosting", "true")) add("hosting", "网站发行 · 上传前端托管", "publish", { webHosting: "true" }, "编译并上传 uniCloud 前端网页托管", "预先登录、开通并绑定云空间", "上传会覆盖云端资源，可能产生云费用");
      } else if (target.startsWith("mp-")) {
        add("compile", "小程序发行 · 仅编译", "publish", has("upload") ? { upload: "false" } : {}, "生产小程序资源编译目录（不等于运行、CI 上传或审核发布）", "需要此目标编译组件；输出目录以 CLI 日志为准", "本地编译；不上传", has("upload") && !supports("upload", "false") ? "当前 CLI 不接受 upload=false，无法保证仅编译模式" : undefined);
        if (supports("upload", "true")) add("upload", "小程序发行 · CI 上传", "publish", { upload: "true" }, "编译并 CI 上传小程序版本（不是审核发布）", "配置应用 AppID、CI 上传私钥、CI 插件和 IP 白名单 / 平台授权", "上传远端版本；不会打开开发者工具");
        if (supports("upload", "false") && has("subPackage")) add("subpackage", "小程序发行 · 混合分包编译", "publish", {}, "指定混合分包的生产编译产物；不上传", "按当前 help：subPackage 与 upload 参数互斥");
      } else {
        add("cli", "平台发行（当前 CLI）", "publish", {}, "此平台产物与副作用以当前 CLI help 和日志为准", command.description || "不从未知平台名称猜测编译或上传语义", "请按 help 核对；云操作可能收费");
      }
    } else if (family === "pack") {
      if (target === "status" || target === "cancel") add(target, target === "status" ? "查看云打包状态" : "取消远端云打包", "manage", {}, target === "status" ? "当前项目云打包状态" : "取消指定平台远端打包任务", "使用既有登录态；CLI 按项目 / 平台定位，不是本地进程 ID", target === "cancel" ? "会取消远端任务；与 Ctrl+K 取消本地进程不同" : "只读查询");
      else if (target === "app-harmony" || target === "mp-harmony") add("package", "本地生成安装包", "publish", {}, target === "app-harmony" ? "鸿蒙本地 .app 安装包（需发布签名；不是调试 HAP）" : "鸿蒙元服务包", "预先配置鸿蒙本地 SDK、发布签名与 CLI 构建工具；元服务仅 classic uni-app");
      else if (command.name === "pack") {
        add("cloud", "App Android / iOS 云打包", "publish", {}, "云端 APK / IPA（结果以云任务状态为准）", "已登录、平台包名 / 证书；自定义基座需显式选择", "提交远端云打包，可能收费；本地取消不取消远端");
        if (has("config")) add("config", "使用已有云打包 JSON", "publish", {}, "云端 APK / IPA（使用经确认的私有配置快照）", "JSON 内 project 必须是捕获的项目绝对路径，不能隐式当前项目", "提交远端云打包，可能收费；配置凭据不显示、不入日志");
      }
    }
  }
  return choices;
}

export function taskMode(choice: TaskChoice, values: Record<string, string>): TaskMode {
  if (choice.command.name.startsWith("launch ")) return values.compile === "true" ? "compile" : choice.mode;
  return choice.mode;
}

/** Only installed parameters are used; conditions follow documented product modes. */
export function taskParameters(choice: TaskChoice, values: Record<string, string>): Parameter[] {
  const name = choice.command.name === "publish" ? "publish " + choice.target : choice.command.name;
  return choice.command.parameters.filter((parameter) => {
    const key = parameter.name;
    if (projectKeys.includes(key) || key === "help" || key in choice.defaults) return false;
    if (choice.id.endsWith(":config")) return key === "config";
    if (key === "config") return false;
    if (choice.command.name === "publish" && !/^app(?:-|$)/.test(choice.target) && key === "type") return false;
    if (name === "launch web" && choice.mode === "compile" && key === "browser") return false;
    if (parameter.required) return true;
    if (choice.defaults.type === "appResource" && ["name", "path", "confuse", "sourceMap"].includes(key)) return false;
    if (name.startsWith("publish mp-") && key === "subPackage" && !choice.id.endsWith(":subpackage")) return false;
    if (name.startsWith("publish mp-") && key === "upload" && choice.id.endsWith(":subpackage")) return false;
    if (name === "pack") {
      const platform = values.platform || "android";
      if (key.startsWith("android.") && !platform.split(",").includes("android")) return false;
      if (key.startsWith("ios.") && !platform.split(",").includes("ios")) return false;
      if (/^android\.(certalias|certfile|certpassword|storepassword)$/.test(key) && (values["android.androidpacktype"] || "0") !== "0") return false;
    }
    const upload = values.upload === "true";
    if (name.startsWith("publish mp-") && /^(appid|privatekey|version|description|robot)$/.test(key) && !upload) return false;
    if (name === "publish web" && /^(provider|spaceId)$/.test(key) && values.webHosting !== "true") return false;
    if (name === "publish web" && /^ssr(Host|Provider)$/.test(key) && values.ssr !== "true") return false;
    if (key === "platform" && name !== "pack" && name !== "pack cancel") return false;
    if (name.startsWith("launch ") && choice.mode === "compile" && /^(deviceId|playground|browser|iosTarget)$/.test(key)) return false;
    return true;
  });
}

export function taskRequiredParameters(choice: TaskChoice, values: Record<string, string>): string[] {
  const required: string[] = [];
  const name = choice.command.name;
  if (name === "pack" && !choice.id.endsWith(":config")) {
    const platforms = (values.platform || "android").split(",");
    if (platforms.includes("android")) {
      required.push("android.packagename");
      if ((values["android.androidpacktype"] || "0") === "0")
        required.push("android.certalias", "android.certfile", "android.certpassword", "android.storepassword");
    }
    if (platforms.includes("ios")) required.push("ios.bundle");
  }
  if (choice.id.endsWith(":subpackage")) required.push("subPackage");
  if ((name.startsWith("publish mp-") || name === "publish" && choice.target.startsWith("mp-")) && values.upload === "true")
    required.push("appid", "privatekey");
  if ((name === "publish web" || name === "publish" && choice.target === "web") && values.webHosting === "true")
    required.push("provider", "spaceId");
  if (choice.id.endsWith(":config")) required.push("config");
  if (name === "pack cancel") required.push("platform");
  return required.filter((key) => choice.command.parameters.some((parameter) => parameter.name === key));
}

export function validateTask(choice: TaskChoice, values: Record<string, string>): void {
  for (const key of taskRequiredParameters(choice, values))
    if (!values[key]?.trim()) throw new Error(`当前模式必须填写 --${key}`);
  for (const [key, value] of Object.entries(choice.defaults)) if (values[key] !== value) throw new Error(`此模式固定 --${key} ${value}`);
  if (choice.command.name === "launch web" && values.browser) {
    const browser = choice.command.parameters.find((parameter) => parameter.name === "browser");
    if (!browser || browser.choices.length && !browser.choices.includes(values.browser)) throw new Error("当前 CLI 不支持所选 Web 浏览器");
  }
  if (choice.command.name === "pack" && !choice.id.endsWith(":config")) {
    const platforms = (values.platform || "android").split(",");
    if (platforms.some((platform) => !["android", "ios"].includes(platform))) throw new Error("云打包平台仅 android / ios，使用英文逗号多选");
  }
  if (values.subPackage && values.upload !== undefined) throw new Error("当前 CLI help 规定 subPackage 与 upload 不能同时填写");
  if (values.robot && (!/^\d+$/.test(values.robot) || +values.robot < 1 || +values.robot > 30)) throw new Error("robot 必须为 1–30");
}
