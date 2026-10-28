import { resolve } from "node:path";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const runtime = process.versions.bun;
  const [major, minor] = runtime?.split(".").map(Number) ?? [];
  if (!runtime || major < 1 || (major === 1 && minor < 4)) {
    throw new Error("lazyhb requires Bun >=1.4.0. Run with Bun, not Node.js.");
  }
  let project: string | undefined;
  let cli: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--help" || value === "-h") {
      console.log(
        "lazyhb [项目目录或 manifest.json] [--cli CLI路径或命令名]\n\nBun + OpenTUI 的 HBuilderX 终端工作台。不会自动打开 IDE。\n--version 版本号\n--help    本帮助\nCLI 启动优先级：--cli > HX_CLI > 已保存 CLI > 默认位置/PATH；指定无效时不回退其它版本。\n\n左侧项目/配置始终保留列表；最近选中组分配更多高度，另一组保留列表预览。没有整体隐藏/收窄导航开关。\n配置标题内有常规/App/平台页签。Tab/Shift+Tab 循环视图，1..4 直达项目/分类/字段/操作，0 聚焦当前主视图。\n[ / ]：配置焦点切配置组，操作焦点切项目/配置/资源/工具组，其它焦点切主区页签。\n字段列：字段/当前值/类型；操作列：操作/快捷键/说明。Space 展开/收缩领域或日志。\nEnter 选择，Ctrl+S 保存；? 查看滚动帮助，Esc 关闭并恢复焦点。\n项目列表 o 或右键打开目标项目上下文；r 运行/仅编译，Shift+R 发行/打包。\nt 空闲时打开高级 CLI；任务活跃时打开任务菜单（停止/查看日志等）。\n任务按当前 CLI 能力选择目标与产物模式；无安全能力或明确项目选择器时解释限制，不回退 IDE 隐式项目。\nWeb/常规小程序/快应用开发入口仅编译，不启动浏览器或开发者工具；App 区分设备运行和仅编译。\n发行区分本地资源/WGT/安装包、Web构建/托管、小程序资源/上传；开发编译不等于生产发行。\n设备查询显示CLI真实输出；手工指定ID或明确使用首设备。云打包状态/取消绑定项目，不使用本地任务号冒充远端ID。\nCtrl+K、顶部停止按钮或工具组停止操作：停止本地任务/连接/候选CLI验证；不保证设备App已关闭或远端云包已取消。\n停止中等待本地进程树结束；重复停止幂等。忙时可浏览导航/日志/属性/设置，冲突任务、写操作及切项目仍受保护，不刷任务日志。\nf 项目文件管理：离线 Iconify 文件/目录图标，终端内图片预览；Esc 关闭预览。\n逗号打开设置；Ctrl+T 下一主题；设置主题行 Left/h 上一、Right/l/Enter 下一，Esc 关闭。\n默认 Gruvbox Light，主题保存成功后生效；设置中可切换 HBuilderX CLI。\nCLI 发现且保存成功后才替换当前连接；候选验证取消不保存、不替换原连接；运行任务时不可切换。\nq / Ctrl+C 退出，未保存修改或运行任务会提示；表单中的导航字符按普通文本输入。",
      );
      console.log(
        "r / Shift+R / f：项目列表焦点针对高亮项目，主区针对已加载项目；o / 右键捕获菜单目标。\n项目任务锁定明确项目与模式参数；参数填写后再次确认，默认取消。详细条件与官方依据见 docs/run-publish-workflows.md。",
      );
      console.log("项目文件列表：Enter/l 进入选中目录或打开文件；←/h/Backspace 返回上级并保留选择，不越过项目根；特殊菜单行保持 Enter 语义。图片 Esc 返回原项；文本编辑 h/l 仍输入字符。");
      return;
    }
    if (value === "--version") {
      console.log(
        (await Bun.file(new URL("../package.json", import.meta.url)).json())
          .version,
      );
      return;
    }
    if (value === "--cli") {
      cli = args[++index];
      if (!cli || cli.startsWith("--"))
        throw new Error("--cli 需要可执行文件路径");
    } else if (value.startsWith("-")) throw new Error("未知参数：" + value);
    else if (project) throw new Error("只接受一个项目路径");
    else project = resolve(value);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("交互工作台需要真实终端；使用 --help 查看用法。");
  const [{ createCliRenderer }, { Workspace }] = await Promise.all([
    import("@opentui/core"),
    import("./app.js"),
  ]);
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    useMouse: true,
    consoleMode: "disabled",
    openConsoleOnError: false,
  });
  const workspace = new Workspace(renderer, { project, cli });
  const stop = () => {
    void workspace.shutdown().catch((error) => {
      renderer.destroy();
      process.exitCode = 1;
      console.error(String(error));
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  try {
    renderer.start();
    await workspace.init();
    await renderer.closed;
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
    await workspace.shutdown();
  }
}
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      "lazyhb: " + (error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
  }
}
