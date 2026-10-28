import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import { themeLabel, type Theme, type ThemePreference } from "./theme.js";

const helpSections: [string, [string, string][]][] = [
  ["工作区导航", [
    ["1 / 2", "聚焦项目 / 配置；选中组多分空间，其它组保留列表预览"],
    ["3 / 4 / 0", "字段 / 操作 / 当前主区；保留最近导航组及高度"],
    ["Tab / Shift+Tab", "切换面板；项目和配置列表始终可见"],
    ["← → / h l", "上一个 / 下一个面板"],
    ["[ / ]", "配置焦点切常规 / App / 平台；操作焦点切项目 / 配置 / 资源 / 工具；其它焦点切主区"],
    ["Space", "折叠选中配置域或日志预览，不手动折叠导航组"],
  ]],
  ["选择与编辑", [
    ["↑ ↓ / k j", "选择列表项；Shift+↑↓ 快速移动"],
    ["Enter", "切换项目、展开配置域、进入字段或编辑字段"],
    ["e / a", "编辑字段 / 添加扩展字段"],
    ["Ctrl+S", "保存 manifest 草稿到磁盘"],
    ["p / f", "导入项目 / 项目文件管理；项目列表焦点针对高亮项目，其它焦点针对已加载项目"],
    ["o / 项目右键", "打开高亮项目的上下文菜单；取消不切换，不丢已加载项目草稿"],
    ["4 操作", "分组清单：项目 / 配置 / 资源 / 工具；标题不是可执行操作"],
    ["字段清单", "固定字段 / 当前值 / 类型列；窄屏隐藏类型，完整路径和说明见详情"],
  ]],
  ["CLI 与外观", [
    [",", "打开设置：自动（终端）/命名主题与 HBuilderX CLI"],
    ["Ctrl+T", "下一主题；设置中 ←/h 上一主题（增强协议另支持 Ctrl+Shift+T）"],
    ["设置 → CLI", "选择历史版本、输入或浏览路径、恢复自动发现"],
    ["r / Shift+R", "平台 → 模式 / 产物 → 目标与条件参数 → 默认取消确认；仅编译不冒充运行"],
    ["t", "空闲时打开高级 CLI；连接或运行中打开当前任务菜单，可停止本地任务 / 查看日志"],
    ["Ctrl+K / 页头停止", "停止本地 CLI 进程树 / 监听；不会确认设备 App 已停，也不取消远端云任务"],
    ["任务运行中", "导航、字段查看、日志、帮助和设置仍可用；修改、切项目/CLI、新任务先停止；t 或操作工具组可停止"],
    ["CLI 切换", "验证成功并保存后才替换；取消验证保留旧连接和输入，可重试"],
  ]],
  ["对话框与安全", [
    ["Esc", "取消 / 关闭；返回打开前的面板"],
    ["Tab / Shift+Tab", "切换控件；选择框用 ↑↓ 和 Enter"],
    ["项目文件列表", "Enter/l 进入目录或打开文件；←/h/Backspace 返回上级（不越过项目根）；o 操作菜单；Esc 返回配置"],
    ["图片预览 Esc", "返回原目录并保留原选择；文本编辑中 h/l 仍是输入文本"],
    ["确认摘要", "Tab 聚焦只读摘要；PgUp/PgDn 滚动，摘要焦点 ↑↓/jk/Home/End；默认取消，按钮固定可见"],
    ["Alt+↑ / Alt+↓", "表单上一 / 下一字段"],
    ["Ctrl+S", "应用表单；manifest 改内存后仍需工作区保存"],
    ["Ctrl+A / Ctrl+U", "全选文本 / 清空凭据输入"],
    ["q / Ctrl+C", "退出前检查草稿与运行中的 CLI"],
    ["输入框", "?、数字、空格和 h/j/k/l 是文本，不触发工作区快捷键"],
  ]],
];

/** Read-only rows use terminal layout cells, never JS string-length padding. */
export class HelpOverlay {
  readonly box: BoxRenderable;
  readonly scroll: ScrollBoxRenderable;
  private footer: TextRenderable;
  private headings: TextRenderable[] = [];
  private keys: TextRenderable[] = [];
  private descriptions: TextRenderable[] = [];
  private rows: BoxRenderable[] = [];
  constructor(private renderer: CliRenderer, theme: Theme) {
    this.box = new BoxRenderable(renderer, { id: "shortcut-help", position: "absolute", top: 1, left: 1,
      border: true, title: " 帮助 · 只读 ", flexDirection: "column", paddingX: 1, zIndex: 100 });
    this.scroll = new ScrollBoxRenderable(renderer, { id: "help-scroll", flexGrow: 1, minHeight: 0,
      scrollX: false, scrollY: true, contentOptions: { flexDirection: "column", paddingRight: 1 } });
    this.box.add(this.scroll);
    for (const [title, entries] of helpSections) {
      const heading = new TextRenderable(renderer, { content: title, height: 1, marginTop: 1, marginBottom: 1, flexShrink: 0 });
      this.headings.push(heading);
      this.scroll.add(heading);
      for (const [key, description] of entries) {
        const row = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, minHeight: 1, marginBottom: 1 });
        const keyText = new TextRenderable(renderer, { content: key, width: 20, flexShrink: 0, wrapMode: "word" });
        const text = new TextRenderable(renderer, { content: description, flexGrow: 1, minWidth: 0, wrapMode: "word" });
        this.keys.push(keyText); this.descriptions.push(text); this.rows.push(row);
        row.add(keyText); row.add(text); this.scroll.add(row);
      }
    }
    this.footer = new TextRenderable(renderer, { content: "↑↓ / jk 滚动 · PgUp/PgDn 翻页 · Home/End · Esc / ? 关闭", height: 2, flexShrink: 0, marginTop: 1, wrapMode: "word" });
    this.box.add(this.footer);
    renderer.root.add(this.box);
    this.resize(); this.setTheme(theme); this.scroll.focus();
  }
  resize(): void {
    this.box.width = Math.max(1, this.renderer.width - 2);
    this.box.height = Math.max(3, this.renderer.height - 2);
    const stacked = this.renderer.width < 58;
    this.rows.forEach((row) => { row.flexDirection = stacked ? "column" : "row"; });
    this.keys.forEach((key) => { key.width = stacked ? "100%" : 20; });
  }
  setTheme(theme: Theme): void {
    this.box.backgroundColor = theme.surface; this.box.borderColor = theme.accent; this.box.titleColor = theme.accent;
    this.headings.forEach((text) => { text.fg = theme.accent; });
    this.keys.forEach((text) => { text.fg = theme.foreground; });
    this.descriptions.forEach((text) => { text.fg = theme.muted; });
    this.footer.fg = theme.muted;
    this.scroll.scrollbarOptions = { trackOptions: { backgroundColor: theme.border, foregroundColor: theme.accent } };
  }
  handleKey(key: KeyEvent): void {
    const amount = ["up", "k"].includes(key.name) ? -1 : ["down", "j"].includes(key.name) ? 1
      : key.name === "pageup" ? -Math.max(1, this.scroll.viewport.height - 1)
      : key.name === "pagedown" ? Math.max(1, this.scroll.viewport.height - 1) : 0;
    if (amount) { key.preventDefault(); this.scroll.scrollBy(amount); }
    else if (key.name === "home" || key.name === "end") {
      key.preventDefault(); this.scroll.scrollTo(key.name === "home" ? 0 : this.scroll.scrollHeight);
    }
  }
  destroy(): void { this.box.destroyRecursively(); }
}

export class SettingsOverlay {
  readonly box: BoxRenderable;
  private rows: TextRenderable[];
  private rowBackgrounds: BoxRenderable[] = [];
  private description: TextRenderable;
  private error: TextRenderable;
  private footer: TextRenderable;
  private selected = 0;
  constructor(private renderer: CliRenderer, private theme: Theme,
    private changeTheme: (delta: number) => void, private configureCli: () => void) {
    this.box = new BoxRenderable(renderer, { id: "workspace-settings", position: "absolute", top: "10%", left: "5%", width: "90%", height: "80%",
      border: true, title: " 设置 ", padding: 1, flexDirection: "column", zIndex: 100 });
    this.box.focusable = true;
    this.rows = ["主题", "HBuilderX CLI"].map((content, index) => {
      const background = new BoxRenderable(renderer, { height: 2, flexShrink: 0 });
      const row = new TextRenderable(renderer, { id: index === 0 ? "settings-theme" : "settings-cli", content, width: "100%", height: "100%", wrapMode: "word" });
      background.add(row);
      this.rowBackgrounds.push(background);
      row.onMouseDown = (event) => { event.preventDefault(); event.stopPropagation(); this.selected = index; this.style(); if (index === 1) configureCli(); };
      this.box.add(background); return row;
    });
    this.description = new TextRenderable(renderer, { content: "", flexGrow: 1, minHeight: 0, wrapMode: "word" });
    this.error = new TextRenderable(renderer, { content: "", height: 3, flexShrink: 0, wrapMode: "word" });
    this.footer = new TextRenderable(renderer, { content: "↑↓ / Tab 选择 · ←/h 上一主题 · →/l/Enter 下一主题或配置 CLI · Esc 关闭", height: 3, flexShrink: 0, wrapMode: "word" });
    this.box.add(this.description); this.box.add(this.error); this.box.add(this.footer);
    renderer.root.add(this.box); this.style(); this.box.focus();
  }
  update(theme: Theme, cli: string, preference: ThemePreference): void {
    this.theme = theme; this.rows[0].content = `主题    ${themeLabel(preference, theme)}`;
    this.rows[1].content = "HBuilderX CLI    Enter 选择 / 配置";
    this.description.content = `\n${cli}\n\n主题即时预览并保存，下次启动沿用。自动（终端）随终端深浅模式变化，无法检测时使用深色；命名主题始终固定。CLI 先独立验证，再保存并切换；失败保留当前连接。`;
    this.style();
  }
  showError(message: string): void { this.error.content = message; }
  private style(): void {
    const t = this.theme;
    this.box.backgroundColor = t.surface; this.box.borderColor = t.accent; this.box.titleColor = t.accent;
    this.rows.forEach((row, index) => {
      row.fg = index === this.selected ? t.selectedForeground : t.foreground;
      row.bg = index === this.selected ? t.selectedBackground : t.surface;
      this.rowBackgrounds[index]!.backgroundColor = row.bg;
    });
    this.description.fg = t.foreground; this.error.fg = t.error; this.footer.fg = t.muted;
  }
  handleKey(key: KeyEvent): void {
    if (["up", "down", "j", "k", "tab"].includes(key.name)) { key.preventDefault(); this.selected = 1 - this.selected; this.style(); }
    else if (["left", "right", "h", "l", "return"].includes(key.name)) {
      key.preventDefault(); if (this.selected === 0) this.changeTheme(["left", "h"].includes(key.name) ? -1 : 1);
      else if (!["left", "h"].includes(key.name)) this.configureCli();
    }
  }
  destroy(): void { this.box.destroyRecursively(); }
}
