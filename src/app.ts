import {
  BoxRenderable,
  TextRenderable,
  type SelectRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type SelectRenderableOptions,
  type ThemeMode,
} from "@opentui/core";
import { CompactSelectRenderable } from "./select.js";
import * as fs from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import JSON5 from "json5";
import {
  JsonDocument,
  manifestPath,
  projectKind,
  parsePointer,
  pointer,
} from "./config.js";
import {
  categories,
  categoryFields,
  setField,
  disableModule,
  sensitive,
  type Category,
  type Field,
} from "./catalog.js";
import { iconSlots } from "./icon-slots.js";
import {
  generateIcons,
  generateStoryboard,
  importNativePlugin,
  validateIcon,
  validateSplash,
} from "./assets.js";
import {
  ProjectFiles,
  ProjectRegistry,
  discoverProjects,
  projectName,
  type Project,
} from "./projects.js";
import { HXClient, CLICancelledError, executable, type Command } from "./hx.js";
import { Dialogs, type Entry } from "./dialogs.js";
import { resolveTheme, themeLabel, THEME_CHOICES, type Theme } from "./theme.js";
import { loadSettings, saveSettings, type Settings } from "./settings.js";
import { HelpOverlay, SettingsOverlay } from "./overlays.js";
import { categoryDomains, categoryTabs, workspacePages } from "./navigation.js";
import { loadFileIcon, fileTypeLabel } from "./file-icons.js";
import { decodeProjectImage, isPreviewImage } from "./image-preview.js";
import { tableRow, fieldColumns, actionColumns } from "./checklist.js";
import { taskChoices, taskMode, taskParameters, taskRequiredParameters, validateTask, type TaskChoice, type TaskKind } from "./task-catalog.js";
import { TaskRunner, type TaskRecord } from "./task-runner.js";
import { loadPackDefaults } from "./pack-defaults.js";

const MISSING = Symbol("missing manifest field");
const actionGroups = [
  { title: "项目", actions: [
    ["run", "运行 / 编译", "r", "选择当前 CLI 支持的真实运行或仅编译目标"],
    ["publish", "发行 / 打包", "Shift+R", "发行、云打包及打包状态 / 取消；云操作可能收费"],
    ["files", "项目文件管理", "f", "终端浏览、编辑与图片预览"],
    ["alias", "修改项目别名", "", "仅修改 lazyhb 别名，不改源码目录"],
    ["refresh", "刷新项目配置", "", "重新读取磁盘 manifest"],
    ["remove", "移除项目", "", "仅从 lazyhb 列表移除，不删除源码"],
    ["properties", "项目属性", "", "查看绝对路径、类型及 manifest"],
    ["import", "导入项目", "p", "选择目录并加入 lazyhb 项目列表"],
  ] },
  { title: "配置", actions: [
    ["edit", "编辑字段", "e", "编辑当前选中字段"],
    ["add", "添加扩展字段", "a", "按 JSON Pointer 添加配置"],
    ["delete", "删除选中字段", "", "确认后删除当前配置项"],
    ["source", "源码编辑", "", "编辑 manifest 草稿，仍需保存"],
    ["save", "保存配置", "Ctrl+S", "将 manifest 草稿写入磁盘"],
  ] },
  { title: "资源", actions: [
    ["icons", "生成全部图标", "", "按平台尺寸生成并配置图标"],
    ["splash", "校验启动资源", "", "校验图片及 storyboard 资源"],
    ["storyboard", "生成 iOS 启动包", "", "生成本地启动资源，不是最终 IPA"],
    ["plugin", "导入本地插件", "", "导入本地原生插件与配置"],
  ] },
  { title: "工具", actions: [
    ["commands", "高级 CLI 任务", "t", "其它动态发现的 CLI 能力，提交后再次确认"],
    ["stop", "停止本地任务", "Ctrl+K", "停止本地 CLI 进程树 / 监听；不保证设备 App 或远端任务停止"],
    ["connect", "连接 / 刷新 CLI", "", "重新发现当前 CLI 能力"],
    ["cli", "切换 / 配置 CLI", "", "验证候选版本成功后切换"],
    ["settings", "设置：主题与 CLI", ",", "主题及 CLI 路径设置"],
    ["logs", "查看完整日志", "", "查看本地任务日志"],
  ] },
] as const;
const projectActions: Record<string, true> = { run: true, publish: true, files: true, alias: true, refresh: true, remove: true, properties: true };
export interface WorkspaceOptions {
  project?: string;
  cli?: string;
}

export class Workspace {
  private registry = new ProjectRegistry();
  private projects: Project[] = [];
  private project?: Project;
  private document?: JsonDocument;
  private groups: Category[] = categories("uni-app");
  private fields: Field[] = [];
  private refreshing = false;
  private disposed = false;
  private group = "basic";
  private client?: HXClient;
  private pendingClient?: HXClient;
  private connectionAbort?: AbortController;
  private stopping?: Promise<void>;
  private taskName = "";
  private blockedNotice = false;
  private blockedReason = "";
  private cliChoice?: string;
  private cliSource = "自动发现";
  private connectedSource = "";
  private commands: Command[] = [];
  private connecting = false;
  private actionBusy = false;
  private resourceBusy = false;
  private quitting = false;
  private messages: string[] = [];
  private dialogs: Dialogs;
  private title: TextRenderable;
  private status: TextRenderable;
  private projectList: SelectRenderable;
  private pageList: SelectRenderable;
  private groupList: SelectRenderable;
  private fieldList: SelectRenderable;
  private actionList: SelectRenderable;
  private taskList: SelectRenderable;
  private fullLogList: SelectRenderable;
  private contentBox: BoxRenderable;
  private overview: BoxRenderable;
  private overviewDetails: TextRenderable;
  private configView: BoxRenderable;
  private categoryPanel: BoxRenderable;
  private fieldView: BoxRenderable;
  private logsView: BoxRenderable;
  private taskPanel: BoxRenderable;
  private outputPanel: BoxRenderable;
  private taskDetails: TextRenderable;
  private fieldHeader: TextRenderable;
  private actionHeader: TextRenderable;
  private taskStopControl: TextRenderable;
  private groupTabs: TextRenderable[] = [];
  private labelBackgrounds = new Map<TextRenderable, BoxRenderable>();
  private taskControl: TextRenderable;
  private moreControl: TextRenderable;
  private collapsedDomains = new Set<string>();
  private categoryTab = 0;
  private categorySelections = ["basic", "", ""];
  private categoryCursors = ["basic", "", ""];
  private page = 0;
  private selectedTaskId = 0;
  private logPositions = new Map<number, number>();
  private displayedLogId = 0;
  private displayedLines: readonly string[] = [];
  private displayedLineCount = -1;
  private displayedLastLine = "";
  private runner = new TaskRunner(() => {
    if (this.disposed) return;
    if (!this.runner.active) this.blockedNotice = false;
    this.refreshTasks();
    this.updateStatus();
  });
  private focus: Renderable[];
  private root: BoxRenderable;
  private sidebar: BoxRenderable;
  private main: BoxRenderable;
  private panels: BoxRenderable[];
  private detailBox: BoxRenderable;
  private detail: TextRenderable;
  private footer: TextRenderable;
  private activePanel = 2;
  private settings: Settings = loadSettings();
  private theme: Theme;
  private terminalMode: ThemeMode | null;
  private help?: HelpOverlay;
  private settingsView?: SettingsOverlay;
  private readonly resizeHandler = () => this.resizeLayout();
  private readonly keyHandler = (key: KeyEvent) => this.handleKey(key);
  private readonly themeModeHandler = (mode: ThemeMode) => {
    this.terminalMode = mode;
    if (this.disposed || this.settings.theme !== "auto") return;
    this.theme = resolveTheme("auto", mode);
    this.applyTheme();
  };
  private readonly destroyHandler = () => {
    this.disposed = true;
    this.connectionAbort?.abort();
    void Promise.all([this.runner.stopAll(), this.client?.cancel(), this.pendingClient?.cancel(), this.stopping])
      .catch((error) => { process.stderr.write("停止本地 CLI 进程树失败：" + String(error) + "\n"); });
    this.removeListeners();
  };
  private fieldWidth = -1;
  private actionWidth = -1;
  private readonly tableLayoutHandler = () => {
    if (this.disposed) return;
    if (this.fieldList.visible && this.fieldWidth !== this.fieldList.width) this.formatFields();
    if (this.actionList.visible && this.actionWidth !== this.actionList.width) this.formatActions();
  };

  constructor(
    private renderer: CliRenderer,
    private options: WorkspaceOptions = {},
  ) {
    this.terminalMode = renderer.themeMode;
    this.theme = resolveTheme(this.settings.theme, this.terminalMode);
    this.cliChoice = options.cli ?? process.env.HX_CLI ?? this.settings.cli;
    this.cliSource = options.cli !== undefined ? "--cli 启动参数"
      : process.env.HX_CLI !== undefined ? "HX_CLI 启动环境"
      : this.settings.cli ? "已保存设置" : "自动发现";
    this.root = new BoxRenderable(renderer, {
      id: "workspace",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      paddingX: 1,
      backgroundColor: this.theme.background,
    });
    renderer.root.add(this.root);
    this.root.onMouseDown = (event) => {
      if (!this.navigationLocked()) return;
      // OpenTUI auto-focus runs after bubbling unless default is prevented.
      // Dialogs/help are siblings of this root and remain fully interactive.
      event.preventDefault();
      event.stopPropagation();
    };
    const header = new BoxRenderable(renderer, { height: 2, flexShrink: 0, flexDirection: "row" });
    this.root.add(header);
    this.title = new TextRenderable(renderer, {
      id: "workspace-title", content: "", height: 2, flexGrow: 1, minWidth: 0, wrapMode: "none",
    });
    header.add(this.title);
    this.moreControl = new TextRenderable(renderer, { id: "workspace-more", content: "[操作 m]", width: 10, height: 2, flexShrink: 0 });
    this.moreControl.onMouseDown = (event) => {
      event.preventDefault(); event.stopPropagation();
      void this.perform("more");
    };
    header.add(this.moreControl);
    this.taskControl = new TextRenderable(renderer, {
      id: "task-control", content: "", height: 2, width: 26, flexShrink: 0, wrapMode: "none",
    });
    this.taskControl.onMouseDown = (event) => {
      event.preventDefault(); event.stopPropagation();
      if (!this.navigationLocked()) this.switchPage(2);
    };
    header.add(this.taskControl);
    const body = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, minHeight: 3 });
    this.root.add(body);
    this.sidebar = new BoxRenderable(renderer, { width: 24, minWidth: 16, flexShrink: 0, flexDirection: "column" });
    body.add(this.sidebar);
    const projects = this.panel("项目");
    projects.flexGrow = 1;
    this.sidebar.add(projects);
    this.projectList = this.list({ id: "projects", flexGrow: 1 });
    projects.add(this.projectList);
    const pages = this.panel("工作台");
    pages.height = 6; pages.flexShrink = 0;
    this.sidebar.add(pages);
    this.pageList = this.list({ id: "workspace-pages", flexGrow: 1 });
    this.pageList.options = workspacePages.map((name, value) => ({ name, value, description: "" }));
    pages.add(this.pageList);
    this.main = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, minWidth: 0 });
    body.add(this.main);
    this.contentBox = this.panel("项目概览");
    this.contentBox.flexGrow = 1;
    this.main.add(this.contentBox);
    this.overview = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, minHeight: 0 });
    this.contentBox.add(this.overview);
    this.overviewDetails = new TextRenderable(renderer, { id: "project-overview", height: 9, flexShrink: 0, wrapMode: "word" });
    this.overview.add(this.overviewDetails);
    this.actionHeader = new TextRenderable(renderer, { id: "actions-header", height: 1, flexShrink: 0, wrapMode: "none" });
    this.overview.add(this.actionHeader);
    this.actionList = this.list({ id: "overview-actions", flexGrow: 1 });
    this.overview.add(this.actionList);
    this.configView = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, minHeight: 0 });
    this.contentBox.add(this.configView);
    this.categoryPanel = this.panel("配置");
    this.categoryPanel.width = 23; this.categoryPanel.flexShrink = 0;
    this.configView.add(this.categoryPanel);
    this.groupList = this.list({ id: "categories", flexGrow: 1 });
    this.categoryPanel.add(this.groupList);
    this.groupTabs = categoryTabs.map((label, index) =>
      this.borderLabel(this.categoryPanel, label, index * 6, 6, () => this.switchCategoryTab(index)));
    this.fieldView = new BoxRenderable(renderer, { flexDirection: "column", flexGrow: 1, minHeight: 0, minWidth: 0 });
    this.configView.add(this.fieldView);
    this.fieldHeader = new TextRenderable(renderer, { id: "fields-header", height: 1, flexShrink: 0, wrapMode: "none" });
    this.fieldView.add(this.fieldHeader);
    this.fieldList = this.list({ id: "fields", flexGrow: 1 });
    this.fieldView.add(this.fieldList);
    this.detailBox = this.panel("字段详情");
    this.detailBox.flexShrink = 0;
    this.fieldView.add(this.detailBox);
    this.detail = new TextRenderable(renderer, { id: "field-details", flexGrow: 1, wrapMode: "word" });
    this.detailBox.add(this.detail);
    this.logsView = new BoxRenderable(renderer, { flexDirection: "row", flexGrow: 1, minHeight: 0 });
    this.contentBox.add(this.logsView);
    this.taskPanel = this.panel("任务 / 服务");
    this.taskPanel.width = 25; this.taskPanel.flexShrink = 0;
    this.logsView.add(this.taskPanel);
    this.taskList = this.list({ id: "task-records", flexGrow: 1, showDescription: true });
    this.taskList.onMouseDown = (event) => {
      if (event.button !== 0 || this.navigationLocked()) return;
      const row = Math.floor((event.y - this.taskList.y) / 2);
      const capacity = Math.max(1, Math.floor(this.taskList.height / 2));
      if (row < 0 || row >= capacity || event.x < this.taskList.x || event.x >= this.taskList.x + this.taskList.width) return;
      const offset = Math.max(0, Math.min(this.taskList.getSelectedIndex() - Math.floor(capacity / 2), this.taskList.options.length - capacity));
      const index = offset + row;
      if (index >= this.taskList.options.length) return;
      event.preventDefault(); event.stopPropagation();
      this.taskList.setSelectedIndex(index);
      this.taskList.focus();
    };
    this.taskPanel.add(this.taskList);
    this.outputPanel = this.panel("所选任务输出");
    this.outputPanel.flexGrow = 1;
    this.logsView.add(this.outputPanel);
    this.taskDetails = new TextRenderable(renderer, { id: "selected-task-status", height: 4, flexShrink: 0, wrapMode: "word" });
    this.outputPanel.add(this.taskDetails);
    const stopSelected = new TextRenderable(renderer, { id: "stop-selected-task", content: "[停止此任务 Ctrl+K]", height: 1, flexShrink: 0 });
    stopSelected.onMouseDown = (event) => {
      event.preventDefault(); event.stopPropagation();
      if (!this.navigationLocked()) void this.stopTask();
    };
    this.outputPanel.add(stopSelected);
    this.taskStopControl = stopSelected;
    this.fullLogList = this.list({ id: "task-output", flexGrow: 1 });
    this.outputPanel.add(this.fullLogList);
    this.fieldList.onSizeChange = () => this.formatFields();
    this.actionList.onSizeChange = () => this.formatActions();
    this.status = new TextRenderable(renderer, { id: "workspace-status", height: 1, flexShrink: 0, wrapMode: "none" });
    this.root.add(this.status);
    this.footer = new TextRenderable(renderer, { id: "workspace-footer", height: 2, flexShrink: 0, wrapMode: "none" });
    this.root.add(this.footer);
    this.focus = [this.projectList, this.pageList, this.actionList, this.groupList, this.fieldList, this.taskList, this.fullLogList];
    this.panels = [projects, pages, this.contentBox, this.categoryPanel, this.taskPanel, this.outputPanel];
    this.dialogs = new Dialogs(renderer, () => this.restoreFocus(), this.theme);
    this.focus.forEach((list, index) => {
      list.on("focused", () => {
        if (this.navigationLocked()) return;
        this.activePanel = index;
        this.updatePanelFocus();
      });
      list.on("blurred", () => this.updatePanelFocus());
    });
    this.pageList.on("selectionChanged", () => {
      if (!this.refreshing && !this.navigationLocked())
        this.switchPage(Number(this.pageList.getSelectedOption()?.value ?? 0), false);
    });
    this.pageList.on("itemSelected", () => this.focusPanel(this.currentMainPanel()));
    this.projectList.on("itemSelected", () => {
      const item = this.projectList.getSelectedOption()?.value as string | undefined;
      if (item) void this.switchProject(item);
    });
    this.projectList.onMouseDown = (event) => {
      if (event.button !== 2 || this.navigationLocked()) return;
      event.preventDefault(); event.stopPropagation();
      const row = event.y - this.projectList.y;
      const height = this.projectList.height;
      if (row < 0 || row >= height) return;
      const offset = Math.max(0, Math.min(this.projectList.getSelectedIndex() - Math.floor(height / 2), this.projects.length - height));
      const project = this.projects[offset + row];
      if (!project) return;
      this.projectList.setSelectedIndex(offset + row);
      void this.projectMenu(project.path);
    };
    this.groupList.on("selectionChanged", () => {
      if (this.refreshing || this.resourceBusy || this.navigationLocked()) return;
      const key = this.groupList.getSelectedOption()?.value as string | undefined;
      if (key) this.categoryCursors[this.categoryTab] = key;
      if (key && !key.startsWith("@")) this.selectCategory(key);
    });
    this.groupList.on("itemSelected", () => {
      if (this.navigationLocked()) return;
      const key = this.groupList.getSelectedOption()?.value as string | undefined;
      if (key?.startsWith("@")) { this.toggleDomain(key.slice(1)); return; }
      if (this.group === "source") void this.perform("source");
      else this.focusPanel(4);
    });
    this.groupList.onMouseUp = (event) => {
      if (this.navigationLocked() || this.resourceBusy || event.button !== 0) return;
      const row = event.y - this.groupList.y;
      const height = this.groupList.height;
      if (row < 0 || row >= height || event.x < this.groupList.x || event.x >= this.groupList.x + this.groupList.width) return;
      const offset = Math.max(0, Math.min(this.groupList.getSelectedIndex() - Math.floor(height / 2), this.groupList.options.length - height));
      const index = offset + row;
      const key = this.groupList.options[index]?.value as string | undefined;
      if (!key) return;
      this.groupList.setSelectedIndex(index);
      if (key.startsWith("@")) this.toggleDomain(key.slice(1));
    };
    this.taskList.on("selectionChanged", () => {
      if (this.refreshing) return;
      this.logPositions.set(this.selectedTaskId, this.fullLogList.getSelectedIndex());
      this.selectedTaskId = Number(this.taskList.getSelectedOption()?.value ?? 0);
      this.refreshTaskOutput();
      this.updateTaskControl();
    });
    this.taskList.on("itemSelected", () => this.focusPanel(6));
    this.fieldList.on("itemSelected", () => void this.perform("edit"));
    this.actionList.on("itemSelected", () => void this.perform(String(this.actionList.getSelectedOption()?.value)));
    this.fieldList.on("selectionChanged", () => this.updateStatus());
    renderer.keyInput.on("keypress", this.keyHandler);
    renderer.on("resize", this.resizeHandler);
    renderer.on("frame", this.tableLayoutHandler);
    renderer.on("theme_mode", this.themeModeHandler);
    renderer.on("destroy", this.destroyHandler);
    this.applyTheme();
    this.resizeLayout();
    this.updateStatus();
  }
  private panel(title: string): BoxRenderable {
    return new BoxRenderable(this.renderer, {
      title,
      border: true,
      borderColor: this.theme.border,
      backgroundColor: this.theme.surface,
      flexDirection: "column",
      minWidth: 0,
      minHeight: 0,
    });
  }
  private list(options: SelectRenderableOptions): SelectRenderable {
    const list = new CompactSelectRenderable(this.renderer, {
      showDescription: false,
      showScrollIndicator: true,
      ...options,
    });
    list.onMouseDown = () => {
      if (!this.navigationLocked()) list.focus();
    };
    return list;
  }
  private navigationLocked(): boolean {
    return this.dialogs.active || !!this.help || !!this.settingsView;
  }
  private borderLabel(box: BoxRenderable, content: string, left: number, width: number, activate: () => void): TextRenderable {
    // Absolute children occupy the actual top border, not an extra toolbar row.
    const background = new BoxRenderable(this.renderer, {
      position: "absolute", top: -1, left, width, height: 1, zIndex: 2,
    });
    const label = new TextRenderable(this.renderer, {
      content, width: "100%", height: 1, wrapMode: "none",
    });
    background.add(label);
    this.labelBackgrounds.set(label, background);
    box.add(background);
    label.onMouseDown = (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (!this.navigationLocked()) activate();
    };
    return label;
  }
  private currentMainPanel(): number { return this.page === 0 ? 2 : this.page === 1 ? 4 : 6; }
  private restoreFocus(): void {
    if (this.disposed) return;
    this.resizeLayout();
    this.focus[this.activePanel].focus();
    this.updatePanelFocus();
  }
  private focusPanel(index: number): void {
    this.activePanel = index;
    this.restoreFocus();
  }
  private switchPage(index: number, focus = true): void {
    this.page = index;
    this.refreshing = true;
    this.pageList.setSelectedIndex(index);
    this.refreshing = false;
    this.activePanel = focus ? this.currentMainPanel() : 1;
    this.resizeLayout();
    if (focus) this.restoreFocus();
  }
  private switchCategoryTab(index: number): void {
    if (this.resourceBusy) return;
    this.categoryTab = index;
    const domains = categoryDomains(this.groups).filter((domain) => domain.tab === index);
    const selected = this.categorySelections[index] || domains[0]?.categories[0]?.key;
    if (selected) this.group = selected;
    this.refreshFields();
    this.page = 1;
    this.focusPanel(3);
  }
  private toggleDomain(key: string): void {
    if (this.resourceBusy) return;
    if (this.collapsedDomains.has(key)) this.collapsedDomains.delete(key);
    else this.collapsedDomains.add(key);
    this.categoryCursors[this.categoryTab] = "@" + key;
    this.refreshCategoryList("@" + key);
  }
  private cycleFocus(delta: number): void {
    const available = [0, 1, ...(this.page === 0 ? [2] : this.page === 1 ? [3, 4] : [5, 6])];
    const position = available.indexOf(this.activePanel);
    this.focusPanel(available[(position + delta + available.length) % available.length]);
  }
  private updatePanelFocus(): void {
    if (this.disposed) return;
    const unlocked = !this.navigationLocked();
    const owners = [0, 1, this.currentMainPanel(), 3, 5, 6];
    this.panels.forEach((panel, index) => {
      panel.borderColor = unlocked && this.activePanel === owners[index] ? this.theme.accent : this.theme.border;
    });
    this.groupTabs.forEach((label, index) => {
      label.fg = index === this.categoryTab ? this.theme.selectedForeground : this.theme.muted;
      label.bg = index === this.categoryTab ? this.theme.selectedBackground : this.theme.surface;
      this.labelBackgrounds.get(label)!.backgroundColor = label.bg;
    });
    this.taskStopControl.fg = this.theme.warning;
    this.updateTaskControl();
  }
  private styleList(list: SelectRenderable): void {
    const theme = this.theme;
    list.backgroundColor = theme.surface;
    list.textColor = theme.foreground;
    list.focusedBackgroundColor = theme.surface;
    list.focusedTextColor = theme.foreground;
    list.selectedBackgroundColor = theme.selectedBackground;
    list.selectedTextColor = theme.selectedForeground;
    list.descriptionColor = theme.muted;
    list.selectedDescriptionColor = theme.selectedForeground;
  }
  private applyTheme(): void {
    this.renderer.setBackgroundColor(this.theme.background);
    this.root.backgroundColor = this.theme.background;
    for (const box of [...this.panels, this.detailBox]) {
      box.backgroundColor = this.theme.surface;
      box.borderColor = this.theme.border;
      box.titleColor = this.theme.muted;
    }
    for (const list of this.focus) this.styleList(list as SelectRenderable);
    this.title.fg = this.theme.accent;
    this.title.bg = this.theme.background;
    this.moreControl.fg = this.theme.accent;
    this.moreControl.bg = this.theme.background;
    this.detail.fg = this.theme.foreground;
    this.detail.bg = this.theme.surface;
    for (const text of [this.fieldHeader, this.actionHeader, this.overviewDetails, this.taskDetails]) {
      text.fg = this.theme.muted;
      text.bg = this.theme.surface;
    }
    this.status.bg = this.theme.background;
    this.footer.fg = this.theme.muted;
    this.footer.bg = this.theme.background;
    this.dialogs.setTheme(this.theme);
    this.help?.setTheme(this.theme);
    this.updateSettingsView();
    this.updateTitle();
    this.updatePanelFocus();
    this.updateStatus();
  }
  private updateTitle(): void {
    this.title.content = `lazyhb · ${this.project ? projectName(this.project) : "项目工作区"} · ${themeLabel(this.settings.theme, this.theme)}\n${this.project?.path ?? "尚未导入项目 · p 导入 · ? 快捷键帮助"}`;
  }
  private resizeLayout(): void {
    const narrow = this.renderer.width < 90;
    this.sidebar.width = narrow ? 18 : 24;
    this.categoryPanel.width = narrow ? 19 : 25;
    this.taskPanel.width = narrow ? 19 : 29;
    this.overview.visible = this.page === 0;
    this.configView.visible = this.page === 1;
    this.logsView.visible = this.page === 2;
    this.contentBox.title = workspacePages[this.page];
    this.detailBox.height = this.renderer.height >= 36 ? 6 : 4;
    this.overviewDetails.height = this.renderer.height >= 28 ? 9 : 6;
    this.taskDetails.height = this.renderer.height >= 36 ? 6 : 5;
    this.help?.resize();
    this.updateTaskControl();
    this.updatePanelFocus();
    this.formatFields();
    this.formatActions();
  }
  private canStop(): boolean {
    return this.connecting || !!this.client?.running || this.runner.active || !!this.stopping;
  }
  private updateTaskControl(): void {
    this.taskControl.visible = this.canStop();
    const running = this.runner.tasks.filter((task) => task.state === "running" || task.state === "stopping").length;
    this.taskControl.content = `任务日志 → ${running} 活跃\n${this.runner.tasks.length} 个任务 · 可并行新建`;
    this.taskControl.fg = running ? this.theme.warning : this.theme.muted;
    this.taskControl.bg = this.theme.background;
    const selected = this.runner.tasks.find((task) => task.id === this.selectedTaskId);
    const stopHint = this.connecting || this.client?.running ? "Ctrl+K取消当前查询"
      : selected?.state === "running" ? `Ctrl+K停止#${selected.id}`
      : selected?.state === "stopping" ? `#${selected.id}停止中` : "";
    const context = this.activePanel === 0 ? "↑↓选项目 Enter切换 o项目菜单 r运行 R发行"
      : this.activePanel === 1 ? "↑↓选页面 Enter进入"
      : this.page === 0 ? "↑↓选操作 Enter执行 r运行 R发行 f文件"
      : this.page === 1 ? this.activePanel === 3 ? "↑↓选分类 Enter进入 Space折叠 []领域"
        : "↑↓选字段 Enter编辑 a添加 Ctrl+S保存"
      : `Alt+↑↓切任务 ${this.activePanel === 5 ? "↑↓选任务 Enter查看输出" : "↑↓滚动日志 Home/End首尾"} ${stopHint}`;
    this.footer.content = "1项目 2概览 3配置 4日志 · Tab焦点 · m操作搜索 · ?帮助\n" + context;
  }
  private refuseConflict(reason = "文件/配置变更受保护；请先停止活跃任务"): void {
    this.blockedNotice = true;
    this.blockedReason = reason;
    this.updateStatus();
  }
  private async stopTask(): Promise<void> {
    if (this.selectedTaskId && !this.client?.running && !this.connecting) {
      const selected = this.runner.tasks.find((task) => task.id === this.selectedTaskId);
      if (!selected || !["running", "stopping"].includes(selected.state)) {
        this.refuseConflict("所选任务已结束；请在左侧选择要停止的运行任务。");
        return;
      }
      try { await this.runner.stop(this.selectedTaskId); }
      catch (error) { this.log("停止所选任务失败：" + String(error)); }
      return;
    }
    if (this.stopping) return this.stopping;
    if (!this.canStop()) return;
    this.connectionAbort?.abort();
    const pending = this.pendingClient;
    const client = this.client;
    const operation = Promise.all([pending?.cancel(), client?.cancel()]).then(() => {})
      .catch((error) => { this.log("停止本地任务失败：" + String(error)); });
    this.stopping = operation;
    this.updateStatus(); this.formatActions();
    try { await operation; }
    finally {
      if (this.stopping === operation) this.stopping = undefined;
      this.blockedNotice = false;
      if (!this.disposed) { this.updateStatus(); this.formatActions(); }
    }
  }
  private showHelp(): void {
    if (this.navigationLocked()) return;
    this.help = new HelpOverlay(this.renderer, this.theme);
    this.updatePanelFocus();
  }
  private closeHelp(): void {
    this.help?.destroy();
    this.help = undefined;
    this.restoreFocus();
  }
  private cliSummary(): string {
    return this.client
      ? `当前 CLI：${this.client.executable}\n可用命令：${this.commands.length} · 来源：${this.connectedSource}${this.connecting ? "\n正在验证候选版本，当前版本暂不可执行" : ""}`
      : `当前 CLI：未连接 · 可用命令：0\n待连接来源：${this.cliSource}${this.cliChoice ? "\n路径：" + this.cliChoice : ""}`;
  }
  private updateSettingsView(): void {
    this.settingsView?.update(this.theme, this.cliSummary(), this.settings.theme);
  }
  private cycleTheme(delta: number): void {
    const id = THEME_CHOICES[(THEME_CHOICES.indexOf(this.settings.theme) + delta + THEME_CHOICES.length) % THEME_CHOICES.length]!;
    try {
      const next = { ...this.settings, theme: id };
      saveSettings(next);
      this.settings = next;
      this.theme = resolveTheme(id, this.terminalMode);
      this.settingsView?.showError("");
      this.applyTheme();
    } catch (error) {
      const message = "主题未更改，设置保存失败：" + String(error);
      this.settingsView?.showError(message);
      this.log(message);
    }
  }
  private showSettings(): void {
    if (this.navigationLocked()) return;
    this.settingsView = new SettingsOverlay(this.renderer, this.theme,
      (delta) => this.cycleTheme(delta), () => {
        this.closeSettings();
        void this.perform("cli");
      });
    this.updateSettingsView();
    this.updatePanelFocus();
  }
  private closeSettings(): void {
    this.settingsView?.destroy();
    this.settingsView = undefined;
    this.restoreFocus();
  }
  async init(): Promise<void> {
    if (!(await this.registry.exists()))
      for (const item of await discoverProjects())
        await this.registry.add(item.path, item.alias);
    if (this.options.project) {
      const input = resolve(this.options.project);
      const path = basename(input) === "manifest.json" ? dirname(input) : input;
      await this.registry.add(path);
      this.options.project = await fs.realpath(path);
    }
    await this.refreshProjects();
    const selected =
      this.projects.find((item) => item.path === this.options.project) ??
      this.projects[0];
    if (selected) await this.loadProject(selected);
    else {
      this.refreshFields();
      this.log("导入项目后可编辑配置；没有安装 CLI 也可管理本地配置与资源。");
    }
    this.refreshTasks();
    this.switchPage(0);
    void this.connect();
  }
  private async refreshProjects(): Promise<void> {
    this.projects = await this.registry.projects();
    this.projectList.options = this.projects.map((item) => ({
      value: item.path,
      name: projectName(item),
      description: item.path,
    }));
    if (this.project)
      this.projectList.setSelectedIndex(
        Math.max(
          0,
          this.projects.findIndex((item) => item.path === this.project?.path),
        ),
      );
  }
  private async loadProject(project: Project): Promise<void> {
    this.project = project;
    this.document = undefined;
    try {
      this.document = await JsonDocument.load(await manifestPath(project.path));
    } catch (error) {
      this.log("配置加载失败；可在文件管理修复：" + String(error));
    }
    this.updateTitle();
    this.refreshFields();
    this.updateOverview();
    this.projectList.setSelectedIndex(
      Math.max(
        0,
        this.projects.findIndex((item) => item.path === project.path),
      ),
    );
  }
  private async switchProject(path: string): Promise<void> {
    if (this.navigationLocked() || this.quitting) return;
    if (this.canStop() && this.document?.dirty) { this.refuseConflict(); return; }
    if (this.actionBusy || this.resourceBusy) return;
    this.actionBusy = true;
    try {
      if (await this.unsaved()) {
        const item = this.projects.find((project) => project.path === path);
        if (item) await this.loadProject(item);
      }
    } catch (error) {
      this.log(String(error));
    } finally {
      this.actionBusy = false;
    }
  }
  private async projectMenu(path = this.projectList.getSelectedOption()?.value as string | undefined): Promise<void> {
    if (!path || this.navigationLocked() || this.quitting) return;
    if (this.actionBusy || this.resourceBusy) {
      return;
    }
    const capturedPath = resolve(path);
    const project = this.projects.find((item) => item.path === capturedPath);
    if (!project) return;
    this.actionBusy = true;
    let action: string | undefined;
    try {
      action = await this.dialogs.choice(`项目操作：${projectName(project)}`, actionGroups[0].actions
        .filter(([value]) => value !== "import")
        .map(([value, label, shortcut, description]) => ({
          value, label: `${label}${shortcut ? " [" + shortcut + "]" : ""}`, description,
        })), `目标项目：${capturedPath}\n取消不切换项目；操作前检查当前草稿。`);
    } finally {
      this.actionBusy = false;
    }
    if (action) await this.perform(action, capturedPath);
  }
  selectCategory(key: string): void {
    if (this.resourceBusy) return;
    const domain = categoryDomains(this.groups).find((item) => item.categories.some((category) => category.key === key));
    if (!domain) return;
    this.categoryTab = domain.tab;
    this.categorySelections[domain.tab] = key;
    this.categoryCursors[domain.tab] = key;
    this.group = key;
    this.refreshFields();
  }
  private refreshCategoryList(selected = this.categoryCursors[this.categoryTab] || this.group): void {
    const options: { name: string; value: string; description: string }[] = [];
    for (const domain of categoryDomains(this.groups).filter((item) => item.tab === this.categoryTab)) {
      const collapsed = this.collapsedDomains.has(domain.key);
      options.push({
        name: `${collapsed ? "▸" : "▾"} ${domain.title} (${domain.categories.length})`,
        value: "@" + domain.key, description: "",
      });
      if (!collapsed)
        options.push(...domain.categories.map((item) => ({
          name: `  ${item.title}`, value: item.key, description: item.note,
        })));
    }
    this.refreshing = true;
    try {
      this.groupList.options = options;
      this.groupList.setSelectedIndex(Math.max(0, options.findIndex((item) => item.value === selected)));
    } finally {
      this.refreshing = false;
    }
    this.updatePanelFocus();
  }
  private refreshFields(): void {
    const previousIndex = this.fieldList.getSelectedIndex();
    const previous = this.fields[this.fieldList.getSelectedOption()?.value as number];
    const selectedPath = previous ? pointer(previous.path) : undefined;
    this.groups = categories(
      this.document ? projectKind(this.document.data) : "uni-app",
    );
    this.refreshCategoryList();
    const category =
      this.groups.find((item) => item.key === this.group) ?? this.groups[0];
    this.fields =
      this.document && category.key !== "source"
        ? categoryFields(category, this.document)
        : [];
    this.formatFields(selectedPath, previousIndex);
    this.updateStatus();
  }
  private formatFields(selectedPath?: string, previousIndex = this.fieldList.getSelectedIndex()): void {
    if (!this.fieldList || !this.fieldHeader) return;
    const selected = this.fields[this.fieldList.getSelectedOption()?.value as number];
    this.fieldWidth = this.fieldList.width;
    selectedPath ??= selected ? pointer(selected.path) : undefined;
    const widths = fieldColumns(Math.max(1, this.fieldList.width - 3));
    const row = (values: string[]) => tableRow(values, widths, this.renderer.widthMethod);
    this.fieldHeader.content = "  " + row(["字段", "当前值", "类型"]);
    this.fieldList.options = this.fields.length
      ? this.fields.map((field, value) => ({
        value, name: row([field.label, this.display(field), field.kind]),
        description: pointer(field.path) + (field.description ? "\n" + field.description : ""),
      }))
      : [{ name: row([this.group === "source" ? "Enter 编辑源码" : "暂无字段", "", ""]), value: -1, description: "" }];
    const index = selectedPath ? this.fields.findIndex((field) => pointer(field.path) === selectedPath) : -1;
    this.fieldList.setSelectedIndex(index >= 0 ? index : Math.max(0, Math.min(previousIndex, this.fields.length - 1)));
  }
  private formatActions(): void {
    if (!this.actionList || !this.actionHeader) return;
    this.actionWidth = this.actionList.width;
    const selected = this.actionList.getSelectedOption()?.value;
    const widths = actionColumns(Math.max(1, this.actionList.width - 3));
    const row = (values: readonly string[]) => tableRow(values, widths, this.renderer.widthMethod);
    this.actionHeader.content = "  " + row(["操作", "快捷键", "说明"]);
    this.actionList.options = [
      ...actionGroups[0].actions.filter(([value]) => ["run", "publish", "files", "properties"].includes(value)),
      ["config", "全部配置", "3", "打开 manifest 配置工作区"],
      ["more", "操作搜索…", "m", "输入名称直达项目 / 配置 / 资源 / 工具操作"],
    ].map(([value, label, shortcut, description]) => ({ value, name: row([label, shortcut, description]), description }));
    this.actionList.setSelectedIndex(Math.max(0, this.actionList.options.findIndex((option) => option.value === selected)));
    this.updateOverview();
  }
  private updateOverview(): void {
    const document = this.document;
    const common = ["name", "appid", "versionName", "versionCode"].map((key) =>
      `${key}：${document ? String(document.get([key], "未设置")) : "无配置"}`).join("\n");
    this.overviewDetails.content = `${this.project ? projectName(this.project) : "尚未导入项目"} · ${document ? projectKind(document.data) : "项目工作区"}\n${document?.path ?? this.project?.path ?? "p 导入项目"}\n${common}\n运行 / 发行均执行真实 CLI；可同时创建多个独立任务。`;
  }
  private operationUnavailable(action: string): string | undefined {
    if (["logs", "config", "settings", "more"].includes(action)) return;
    if (action === "stop") {
      if (this.connecting || this.client?.running) return;
      const selected = this.runner.tasks.find((task) => task.id === this.selectedTaskId);
      return selected && ["running", "stopping"].includes(selected.state) ? undefined : "请先选中一个运行中的任务";
    }
    if (projectActions[action] && !this.project) return "先导入或选择项目";
    if (action === "properties") return;
    if (["edit", "delete", "add", "source", "save", "icons", "splash", "storyboard", "plugin"].includes(action) && !this.document)
      return "当前项目没有可编辑的 manifest";
    if (["edit", "delete"].includes(action) && !this.fields[this.fieldList.getSelectedOption()?.value as number])
      return "先在配置页选择字段";
    if (this.canStop() && !["run", "publish", "commands", "files"].includes(action))
      return "有活跃任务；请先停止任务再修改配置或切换 CLI";
    if ((this.connecting || this.client?.running) && ["run", "publish", "commands"].includes(action))
      return "CLI 连接或查询进行中，请稍后创建任务";
    if (this.canStop() && this.document?.dirty) return "有活跃任务且草稿未保存，请先处理现有任务";
    if (this.actionBusy || this.resourceBusy) return "当前操作尚未完成";
  }
  private async moreActions(): Promise<void> {
    const targetPath = this.activePanel === 0
      ? this.projectList.getSelectedOption()?.value as string | undefined : this.project?.path;
    const target = this.projects.find((project) => project.path === targetPath);
    const preferred = this.page === 1 ? "配置" : this.page === 2 ? "工具" : "项目";
    const groups = [...actionGroups].sort((a, b) => Number(b.title === preferred) - Number(a.title === preferred));
    const action = await this.dialogs.choice("操作搜索", groups.flatMap((group) =>
      group.actions.map(([value, label, shortcut, description]) => ({
        value, label: `${group.title} · ${label}${shortcut ? ` [${shortcut}]` : ""}`,
        description, disabledReason: this.operationUnavailable(value),
      }))), `项目操作 → ${target ? projectName(target) : "未选择"}${targetPath ? " · " + targetPath : ""}\n配置 / 资源 → ${this.project ? projectName(this.project) : "未加载项目"}`, true);
    if (action) await this.perform(action, targetPath);
  }
  private refreshTasks(): void {
    if (this.selectedTaskId && !this.runner.tasks.some((task) => task.id === this.selectedTaskId)) this.selectedTaskId = 0;
    this.refreshing = true;
    this.taskList.options = [
      { value: 0, name: "工作区通知", description: "CLI 连接、资源与配置操作" },
      ...this.runner.tasks.map((task) => ({
        value: task.id, name: `#${task.id} ${this.taskState(task)} · ${task.label}`, description: task.target ?? task.project ?? "",
      })),
    ];
    this.taskList.setSelectedIndex(Math.max(0, this.taskList.options.findIndex((item) => item.value === this.selectedTaskId)));
    this.refreshing = false;
    this.refreshTaskOutput();
  }
  private taskState(task: TaskRecord): string {
    return ({ running: "运行中", stopping: "停止中", succeeded: "已完成", failed: "失败", cancelled: "已取消" })[task.state];
  }
  private refreshTaskOutput(): void {
    const task = this.runner.tasks.find((item) => item.id === this.selectedTaskId);
    const lines = task?.lines ?? this.messages;
    const changedTask = this.displayedLogId !== this.selectedTaskId;
    const previous = this.fullLogList.getSelectedIndex();
    const follow = !changedTask && previous >= this.fullLogList.options.length - 1;
    this.taskDetails.content = task
      ? `#${task.id} ${task.label} · ${this.taskState(task)}${task.exitCode === undefined ? "" : " · 退出码 " + task.exitCode}\n${task.target ? "目标：" + task.target + "\n" : ""}${task.project ?? "无显式项目"}\n${task.error ?? "仅此任务独立输出；停止 CLI 不保证 Web 服务、浏览器或设备应用停止。"}`
      : "工作区通知\nCLI 连接、设备查询和本地配置操作；不混入任何任务输出。";
    this.taskStopControl.visible = !!task && ["running", "stopping"].includes(task.state);
    this.taskStopControl.content = task?.state === "stopping" ? `#${task.id} 正在停止…`
      : `[停止 CLI #${task?.id ?? ""} Ctrl+K]`;
    if (!changedTask && this.displayedLines === lines && this.displayedLineCount === lines.length && this.displayedLastLine === (lines.at(-1) ?? "")) return;
    this.fullLogList.options = lines.map((name, value) => ({ name: name || " ", value, description: "" }));
    this.fullLogList.setSelectedIndex(changedTask ? this.logPositions.get(this.selectedTaskId) ?? Math.max(0, lines.length - 1)
      : follow ? Math.max(0, lines.length - 1) : previous);
    this.displayedLogId = this.selectedTaskId;
    this.displayedLines = lines;
    this.displayedLineCount = lines.length;
    this.displayedLastLine = lines.at(-1) ?? "";
  }
  private display(field: Field): string {
    if (!this.document) return "";
    const value = this.document.get(field.path, MISSING);
    if (value === MISSING) return "未设置";
    if (sensitive(field.path)) return "[已隐藏]";
    if (value === null) return "null";
    if (field.kind === "module") return "已启用";
    if (typeof value === "object")
      return Array.isArray(value)
        ? `数组（${value.length} 项）`
        : "对象（Enter 编辑）";
    return String(value)
      .replace(/[\r\n]/g, " ")
      .slice(0, 100);
  }
  private updateStatus(): void {
    const field =
      this.fields[this.fieldList.getSelectedOption()?.value as number];
    const category = this.groups.find((item) => item.key === this.group);
    const active = this.canStop();
    this.status.content = `${this.document?.dirty ? "● 未保存" : this.document ? "✓ 已保存" : "无配置"}${this.resourceBusy ? " · 资源处理中" : ""}${active ? " · " + (this.connecting ? "CLI 连接中" : this.taskName || "有活跃任务") : ""}${this.blockedNotice ? " · " + this.blockedReason : ""}`;
    this.updateTaskControl();
    this.updateOverview();
    this.status.fg = this.document?.dirty || this.resourceBusy || active || this.blockedNotice
      ? this.theme.warning
      : this.document ? this.theme.success : this.theme.muted;
    this.detail.content = field
      ? `${field.label} · ${field.kind} · Enter 编辑\n${pointer(field.path)}\n当前：${this.display(field)}${field.description ? "\n" + field.description : ""}`
      : `${category?.title ?? "配置字段"}\n${category?.note ?? ""}\n${this.document ? "Enter 编辑源码 / a 添加扩展字段" : "p 导入项目 · f 文件管理 · ? 查看帮助"}`;
  }
  private log(message: string): void {
    if (this.disposed) return;
    this.messages.push(
      ...message.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").split("\n"),
    );
    if (this.messages.length > 2000)
      this.messages.splice(0, this.messages.length - 2000);
    this.refreshTasks();
    this.updatePanelFocus();
    this.updateStatus();
  }
  private requireDocument(): JsonDocument {
    if (!this.document || !this.project)
      throw new Error("先导入/选择有效项目；损坏的 manifest 可用文件管理修复");
    return this.document;
  }
  private async unsaved(): Promise<boolean> {
    if (!this.document?.dirty) return true;
    const choice = await this.dialogs.choice("manifest 尚未保存", [
      { value: "cancel", label: "取消操作，保留草稿" },
      { value: "save", label: "保存后继续" },
      { value: "discard", label: "放弃草稿并重新加载磁盘文件" },
    ]);
    if (choice === "save") {
      await this.document.save();
      this.refreshFields();
      return true;
    }
    if (choice === "discard") {
      this.document = await JsonDocument.load(this.document.path);
      this.refreshFields();
      return true;
    }
    return false;
  }
  private handleKey(key: KeyEvent): void {
    if (key.ctrl && key.name === "k" && this.canStop()) {
      key.preventDefault(); void this.stopTask(); return;
    }
    if (this.connecting && key.ctrl && key.name === "c") {
      key.preventDefault();
      void this.requestQuit();
      return;
    }
    if (!this.dialogs.active && key.ctrl && key.name === "t") {
      key.preventDefault();
      this.cycleTheme(key.shift ? -1 : 1);
      return;
    }
    if (this.help) {
      if (key.name === "escape" || key.sequence === "?") {
        key.preventDefault();
        this.closeHelp();
      }
      else this.help.handleKey(key);
      return;
    }
    if (this.settingsView) {
      if (key.name === "escape" || key.sequence === ",") {
        key.preventDefault(); this.closeSettings();
      } else this.settingsView.handleKey(key);
      return;
    }
    if (this.dialogs.handleKey(key)) return;
    if (!key.ctrl && !key.meta && !key.option && key.sequence === "?") {
      key.preventDefault();
      this.showHelp();
      return;
    }
    if (!key.ctrl && !key.meta && !key.option && key.sequence === ",") {
      key.preventDefault(); this.showSettings(); return;
    }
    if ((!key.ctrl && !key.meta && !key.option && key.name === "q") || (key.ctrl && key.name === "c")) {
      key.preventDefault();
      void this.requestQuit();
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      this.cycleFocus(key.shift ? -1 : 1);
      return;
    }
    if (this.page === 2 && (key.meta || key.option) && !key.ctrl && ["up", "down"].includes(key.name)) {
      key.preventDefault();
      const tasks = this.runner.tasks;
      if (tasks.length) {
        const current = tasks.findIndex((task) => task.id === this.selectedTaskId);
        const next = current < 0 ? key.name === "up" ? tasks.length - 1 : 0
          : (current + (key.name === "up" ? -1 : 1) + tasks.length) % tasks.length;
        this.taskList.setSelectedIndex(this.taskList.options.findIndex((item) => item.value === tasks[next].id));
      }
      return;
    }
    if (!key.ctrl && !key.meta && !key.option) {
      if (key.name === "o" && this.activePanel === 0) {
        key.preventDefault(); void this.projectMenu(); return;
      }
      if (key.name.toLowerCase() === "r") {
        key.preventDefault(); void this.perform(key.shift || key.sequence === "R" ? "publish" : "run"); return;
      }
      if (/^[0-4]$/.test(key.name)) {
        key.preventDefault();
        if (key.name === "1") this.focusPanel(0);
        else if (key.name === "0") this.focusPanel(this.currentMainPanel());
        else this.switchPage(Number(key.name) - 2);
        return;
      }
      if (key.sequence === "[" || key.sequence === "]") {
        key.preventDefault();
        const delta = key.sequence === "[" ? -1 : 1;
        if (this.page === 1) this.switchCategoryTab((this.categoryTab + delta + 3) % 3);
        else this.switchPage((this.page + delta + 3) % 3);
        return;
      }
      if (key.name === "space" || key.sequence === " ") {
        key.preventDefault();
        const selected = this.groupList.getSelectedOption()?.value as string | undefined;
        if (this.activePanel === 3 && selected?.startsWith("@")) this.toggleDomain(selected.slice(1));
        return;
      }
      if (["left", "right", "h", "l"].includes(key.name)) {
        key.preventDefault();
        this.cycleFocus(["left", "h"].includes(key.name) ? -1 : 1);
        return;
      }
    }
    const action =
      key.ctrl && key.name === "s"
        ? "save"
        : !key.ctrl && !key.meta && !key.option
          ? (
              {
                e: "edit",
                a: "add",
                p: "import",
                f: "files",
                t: "commands",
                m: "more",
              } as Record<string, string>
            )[key.name]
          : undefined;
    if (action) {
      key.preventDefault();
      void this.perform(action);
    }
  }
  async requestQuit(): Promise<void> {
    if (this.quitting || this.help || this.settingsView || (this.dialogs.active && !this.connecting)) return;
    if (this.resourceBusy || (this.actionBusy && !this.client?.running && !this.connecting)) {
      this.log("当前操作尚未完成，暂不能退出。");
      return;
    }
    this.quitting = true;
    try {
      if (this.connecting) {
        await this.stopTask();
        this.dialogs.cancelActive();
      }
      if (this.client?.running || this.runner.active) {
        if (
          !(await this.dialogs.confirm(
            "终止本地 CLI 并退出？远端云任务不会因此取消。",
          ))
        )
          return;
        await Promise.all([this.runner.stopAll(), this.client?.cancel()]);
      }
      if (!(await this.unsaved())) return;
      this.connectionAbort?.abort();
      await Promise.all([this.runner.stopAll(), this.client?.cancel(), this.pendingClient?.cancel()]);
      this.disposed = true;
      this.removeListeners();
      this.renderer.destroy();
    } catch (error) {
      this.log(String(error));
    } finally {
      this.quitting = false;
    }
  }
  async shutdown(): Promise<void> {
    this.disposed = true;
    this.connectionAbort?.abort();
    this.dialogs.cancelActive();
    await Promise.all([this.runner.stopAll(), this.client?.cancel(), this.pendingClient?.cancel(), this.stopping]);
    this.removeListeners();
    this.renderer.destroy();
    await this.renderer.closed;
  }
  private removeListeners(): void {
    this.renderer.keyInput.off("keypress", this.keyHandler);
    this.renderer.off("resize", this.resizeHandler);
    this.renderer.off("frame", this.tableLayoutHandler);
    this.renderer.off("theme_mode", this.themeModeHandler);
    this.renderer.off("destroy", this.destroyHandler);
  }
  private async replaceCli(choice: string | undefined, source: string, persist: boolean): Promise<void> {
    if (this.canStop() || this.resourceBusy)
      throw new Error("CLI 正在连接、运行或处理资源，不能切换版本。");
    this.connecting = true;
    const connection = new AbortController();
    this.connectionAbort = connection;
    this.blockedNotice = false;
    let candidate: HXClient | undefined;
    let committed = false;
    this.updateStatus(); this.updateSettingsView(); this.formatActions();
    try {
      const path = await executable(choice, false);
      if (connection.signal.aborted || this.disposed || this.quitting) throw new CLICancelledError();
      candidate = new HXClient(path);
      this.pendingClient = candidate;
      const commands = await candidate.discover();
      if (connection.signal.aborted || this.disposed || this.quitting) throw new CLICancelledError();
      if (persist) {
        // Read the latest in-memory settings after discovery: theme can change while awaiting the child.
        const next: Settings = { ...this.settings, cli: choice === undefined ? undefined : path,
          recentClis: [path, ...this.settings.recentClis.filter((item) => item !== path)].slice(0, 12) };
        saveSettings(next);
        this.settings = next;
      }
      this.client = candidate;
      this.commands = commands;
      this.cliChoice = choice === undefined ? undefined : path;
      this.cliSource = source;
      this.connectedSource = source;
      committed = true;
      this.log(`CLI 已连接：${path} · ${commands.length} 个可用命令 · 来源：${source}；不会打开 GUI。`);
    } finally {
      if (!committed) await candidate?.cancel();
      if (this.pendingClient === candidate) this.pendingClient = undefined;
      if (this.connectionAbort === connection) this.connectionAbort = undefined;
      this.connecting = false;
      this.blockedNotice = false;
      if (!this.disposed) { this.updateStatus(); this.updateSettingsView(); this.formatActions(); }
    }
  }
  private async connect(): Promise<void> {
    if (this.canStop()) return;
    try { await this.replaceCli(this.cliChoice, this.cliSource, false); }
    catch (error) { this.log(error instanceof CLICancelledError ? "CLI 连接已取消，保留原连接与选择。" : String(error)); }
  }
  private async configureCli(): Promise<void> {
    if (this.canStop())
      throw new Error("CLI 正在连接或运行，不能切换版本。请等待或 Ctrl+K 取消本地任务。");
    while (!this.disposed && !this.quitting) {
      const selected = await this.dialogs.choice("切换 / 配置 HBuilderX CLI", [
        { value: "@input", label: "输入 CLI 路径…", description: this.cliSummary() },
        { value: "@browse", label: "浏览文件选择 CLI…" },
        { value: "@auto", label: "恢复自动发现", description: "忽略本次启动参数与 HX_CLI，验证默认安装后保存" },
        ...this.settings.recentClis.map((path) => ({ value: path, label: path, description: "历史验证路径（切换前会重新验证）" })),
      ]);
      if (!selected || this.disposed || this.quitting) return;
      if (selected === "@input") {
        const values = await this.dialogs.form("输入 CLI 路径（验证失败可直接修正）", [
          { key: "cli", label: "CLI 可执行文件的绝对路径或 PATH 命令", value: this.client?.executable ?? this.cliChoice ?? "",
            description: "Ctrl+S 验证并保存；失败保留旧版本与命令列表。不会启动 GUI。" },
        ], async (values) => {
          if (!values.cli.trim()) throw new Error("请输入 CLI 路径；恢复自动发现请返回选择对应项目。");
          await this.replaceCli(values.cli.trim(), "已保存设置", true);
        });
        if (values || this.disposed || this.quitting) return;
      } else {
        try {
          const path = selected === "@auto" ? undefined : selected === "@browse"
            ? await this.dialogs.path("选择 HBuilderX CLI 可执行文件", this.client?.executable ?? homedir()) : selected;
          if (this.disposed || this.quitting) return;
          if (selected === "@browse" && path === undefined) continue;
          await this.replaceCli(path, path === undefined ? "自动发现（已保存）" : "已保存设置", true);
          return;
        } catch (error) {
          if (this.disposed || this.quitting) return;
          if (error instanceof CLICancelledError) {
            this.log("CLI 连接已取消，保留原连接与选择。");
            continue;
          }
          this.log("CLI 未切换，保留原连接与设置：" + String(error));
          await this.dialogs.choice("CLI 未切换：" + String(error), [{ value: "back", label: "返回修改路径 / 选择其它版本" }]);
        }
      }
    }
  }
  async perform(action: string, capturedPath?: string): Promise<void> {
    if (action === "stop") { await this.stopTask(); return; }
    if (this.navigationLocked() || this.quitting) return;
    if (action === "logs") { this.switchPage(2); return; }
    if (action === "config") { this.switchPage(1); return; }
    if (action === "more") { if (!this.actionBusy) await this.moreActions(); return; }
    if (action === "settings") { this.showSettings(); return; }
    if (action === "properties") {
      const path = capturedPath ?? (this.activePanel === 0 ? this.projectList.getSelectedOption()?.value as string | undefined : this.project?.path);
      const project = this.projects.find((item) => item.path === path);
      try {
        if (!project) throw new Error("先选择项目");
        const info = await fs.stat(project.path);
        await this.dialogs.text("项目属性（只读；不会切换项目）",
          `路径：${project.path}\n别名：${project.alias ?? ""}\nmanifest：${await manifestPath(project.path)}\n修改时间：${info.mtime.toISOString()}\n项目列表：${this.registry.path}`);
      } catch (error) { this.log(String(error)); }
      return;
    }
    const unavailable = this.operationUnavailable(action);
    if (unavailable) { this.refuseConflict(unavailable); return; }
    this.blockedNotice = false;
    const targetPath = capturedPath ?? (this.activePanel === 0 && projectActions[action]
      ? this.projectList.getSelectedOption()?.value as string | undefined
      : this.project?.path);
    this.actionBusy = true;
    try {
      if (projectActions[action]) {
        if (!targetPath) throw new Error("先选择项目；p 可导入项目。");
        const target = this.projects.find((item) => item.path === resolve(targetPath));
        if (!target) throw new Error("目标项目已不在列表中，请重新选择。");
        if (target.path !== this.project?.path) {
          if (!(await this.unsaved())) return;
          await this.loadProject(target);
        }
      }
      if (action === "run" || action === "publish") await this.command(action, this.project!.path);
      else if (action === "connect") await this.connect();
      else if (action === "cli") await this.configureCli();
      else if (action === "import") {
        if (!(await this.unsaved())) return;
        const filename = await this.dialogs.path(
          "导入项目目录",
          this.project?.path ?? homedir(),
          true,
        );
        if (filename) {
          const project = await this.registry.add(filename);
          await this.refreshProjects();
          await this.loadProject(project);
        }
      } else if (action === "save") {
        await this.requireDocument().save();
        this.log("manifest 已保存");
      } else if (action === "source") {
        const document = this.requireDocument();
        await this.dialogs.text(
          "manifest 源码（Ctrl+S 应用到内存，仍需保存）",
          document.text,
          (text) => document.replaceSource(text),
        );
      } else if (action === "edit") await this.editField();
      else if (action === "add") {
        const document = this.requireDocument();
        await this.dialogs.form(
          "添加扩展字段",
          [
            {
              key: "path",
              label:
                "JSON Pointer，例如 /app-plus/distribute/android/minSdkVersion",
            },
            {
              key: "value",
              label: "JSON5 值；字符串需加引号",
              value: '""',
              multiline: true,
            },
          ],
          (values) =>
            document.set(
              parsePointer(values.path.trim()),
              JSON5.parse(values.value),
            ),
        );
      } else if (action === "delete") {
        const document = this.requireDocument();
        const field =
          this.fields[this.fieldList.getSelectedOption()?.value as number];
        if (
          field &&
          (await this.dialogs.confirm("删除字段 " + pointer(field.path) + "？"))
        ) {
          if (field.kind === "module") await this.disable(field);
          else document.delete(field.path);
        }
      } else if (action === "refresh") {
        if ((await this.unsaved()) && this.project)
          await this.loadProject(this.project);
      } else if (action === "alias") {
        if (!this.project) throw new Error("先选择项目");
        const project = this.project;
        await this.dialogs.form(
          "修改 lazyhb 项目别名",
          [
            {
              key: "alias",
              label: "别名（不修改 HBuilderX 内部元数据）",
              value: project.alias,
            },
          ],
          async (values) => {
            await this.registry.alias(project.path, values.alias);
          },
        );
        await this.refreshProjects();
        this.project = this.projects.find(
          (item) => item.path === project.path,
        )!;
        this.updateTitle();
      } else if (action === "remove") {
        if (!this.project || !(await this.unsaved())) return;
        if (
          await this.dialogs.confirm("仅从 lazyhb 移除项目，不删除任何源码？")
        ) {
          await this.registry.remove(this.project.path);
          this.project = undefined;
          this.document = undefined;
          await this.refreshProjects();
          if (this.projects[0]) await this.loadProject(this.projects[0]);
          else { this.updateTitle(); this.updateOverview(); }
        }
      } else if (action === "files") await this.fileManager();
      else if (["icons", "splash", "storyboard", "plugin"].includes(action))
        await this.resource(action);
      else if (action === "commands") await this.command();
    } catch (error) {
      this.log(error instanceof CLICancelledError
        ? "本地 CLI 任务已取消；设备 App / 远端云任务未确认停止。"
        : String(error));
    } finally {
      this.actionBusy = false;
      if (!this.disposed) { this.refreshFields(); this.formatActions(); }
    }
  }
  private async disable(field: Field): Promise<void> {
    const document = this.requireDocument();
    const permissions = document.get([
      "app-plus",
      "distribute",
      "android",
      "permissions",
    ]);
    const indices: number[] = [];
    if (Array.isArray(permissions) && permissions.length) {
      const choice = await this.dialogs.choice(
        "关闭模块时如何处理 Android 权限？",
        [
          { value: "keep", label: "保留全部权限（推荐）" },
          { value: "choose", label: "显式选择要移除的权限" },
        ],
      );
      if (!choice) return;
      if (choice === "choose")
        while (true) {
          const selected = await this.dialogs.choice(
            "仅移除勾选的权限；不推断归属",
            [
              { value: "@done", label: "确认选择并关闭模块" },
              ...permissions.map((value, index) => ({
                value: String(index),
                label: `${indices.includes(index) ? "[x]" : "[ ]"} ${String(value)}`,
              })),
            ],
          );
          if (!selected) return;
          if (selected === "@done") break;
          const index = Number(selected);
          const at = indices.indexOf(index);
          if (at < 0) indices.push(index);
          else indices.splice(at, 1);
        }
    }
    disableModule(document, field, indices);
  }
  private async editField(): Promise<void> {
    const document = this.requireDocument();
    if (this.group === "source") {
      await this.dialogs.text("manifest 源码", document.text, (text) =>
        document.replaceSource(text),
      );
      return;
    }
    const field =
      this.fields[this.fieldList.getSelectedOption()?.value as number];
    if (!field) return;
    const value = document.get(field.path, MISSING);
    if (field.kind === "boolean" || field.kind === "module") {
      const choice = await this.dialogs.choice(field.label, [
        { value: "true", label: "启用 / true" },
        { value: "false", label: "关闭 / false" },
      ]);
      if (!choice) return;
      if (field.kind === "module" && choice === "false")
        await this.disable(field);
      else setField(document, field, choice === "true");
      return;
    }
    if (field.kind === "path") {
      const filename = await this.dialogs.path(
        field.label,
        typeof value === "string" && value
          ? resolve(dirname(document.path), value)
          : dirname(document.path),
      );
      if (!filename) return;
      const slot = iconSlots(projectKind(document.data)).find(
        (item) => pointer(item.path) === pointer(field.path),
      );
      if (slot) await validateIcon(filename, slot.size, slot.ios);
      if (field.path.at(-1) === "storyboard") {
        if (!filename.toLowerCase().endsWith(".zip"))
          throw new Error("storyboard 必须选择 ZIP");
        await validateSplash(filename);
      }
      const name = relative(dirname(document.path), filename);
      setField(
        document,
        field,
        name.startsWith(".." + sep) || name === ".."
          ? filename
          : name.split(sep).join("/"),
      );
      return;
    }
    await this.dialogs.form(
      field.label,
      [
        {
          key: "value",
          label: pointer(field.path),
          value:
            value === MISSING
              ? ""
              : field.kind === "json"
                ? JSON.stringify(value, null, 2)
                : String(value),
          description: `${field.description ?? ""}${field.choices?.length ? "\n可选：" + field.choices.join(", ") : ""}`,
          multiline: field.kind === "json",
          secret: sensitive(field.path),
        },
      ],
      (values) => {
        let next: unknown = values.value;
        if (field.kind === "json") next = JSON5.parse(values.value);
        else if (field.kind === "integer" || field.kind === "number") {
          if (!values.value.trim()) throw new Error("请输入数字");
          next = Number(values.value);
          if (
            !Number.isFinite(next) ||
            (field.kind === "integer" && !Number.isSafeInteger(next))
          )
            throw new Error("请输入有效数字 / 安全整数");
        }
        setField(document, field, next);
      },
    );
  }
  private async resource(action: string): Promise<void> {
    const document = this.requireDocument();
    const project = this.project!;
    const filename = await this.dialogs.path(
      action === "plugin" ? "选择本地原生插件目录" : "选择图片 / 启动资源",
      dirname(document.path),
      action === "plugin",
    );
    if (!filename) return;
    let background = "#ffffff";
    let preserve = true;
    if (action === "icons" || action === "storyboard") {
      const values = await this.dialogs.form(
        "生成资源设置",
        [
          {
            key: "background",
            label: "iOS 无透明背景色 #RRGGBB",
            value: background,
          },
        ],
        (values) => {
          if (!/^#[a-f\d]{6}$/i.test(values.background))
            throw new Error("无效背景色");
        },
      );
      if (!values) return;
      background = values.background;
      if (action === "icons") {
        const choice = await this.dialogs.choice("处理已有手动图标", [
          { value: "preserve", label: "保留全部已配置图标和文件" },
          { value: "replace", label: "替换配置并重新生成图标" },
        ]);
        if (!choice) return;
        preserve = choice === "preserve";
      }
    }
    this.resourceBusy = true;
    this.updateStatus();
    try {
      if (action === "icons")
        this.log(
          `已生成 ${(await generateIcons(project.path, filename, document, preserve, background)).length} 个图标文件，manifest 仍需保存。`,
        );
      else if (action === "splash")
        this.log((await validateSplash(filename)).join("\n"));
      else if (action === "plugin")
        this.log(
          "已导入本地原生插件：" +
            (await importNativePlugin(project.path, filename, document)) +
            "；manifest 仍需保存。",
        );
      else {
        const original = document.text;
        const output = await generateStoryboard(
          project.path,
          filename,
          background,
        );
        try {
          const name = relative(dirname(document.path), output)
            .split(sep)
            .join("/");
          if (projectKind(document.data) === "uni-app-x")
            document.set(
              ["app-ios", "distribute", "splashScreens", "storyboard"],
              name,
            );
          else {
            document.set(
              ["app-plus", "distribute", "splashscreen", "iosStyle"],
              "storyboard",
            );
            document.set(
              ["app-plus", "distribute", "splashscreen", "ios", "storyboard"],
              name,
            );
          }
        } catch (error) {
          document.replaceSource(original);
          await fs.rm(output, { force: true });
          throw error;
        }
        this.log("已生成 " + output + "；manifest 仍需保存。");
      }
    } finally {
      this.resourceBusy = false;
    }
  }
  private async fileManager(): Promise<void> {
    if (!this.project || !(await this.unsaved())) return;
    const project = this.project;
    const files = await ProjectFiles.open(project.path);
    let current = ".";
    const selections = new Map<string, string>();
    try {
      while (!this.disposed && !this.quitting) {
        const entries = await files.entries(current);
        const fileRows = await Promise.all(entries.map(async (filename) => {
          const value = relative(files.root, filename);
          const info = await files.stat(value);
          return {
            value, label: basename(filename),
            loadSource: async () => (await loadFileIcon(basename(filename), info.isDirectory())).source,
            typeLabel: fileTypeLabel(basename(filename), info.isDirectory()),
          };
        }));
        if (this.disposed || this.quitting) break;
        const result = await this.dialogs.fileChoice(
          "项目文件：" + join(files.root, current),
          [
            { value: "@close", label: "返回工作台" },
            { value: "@up", label: "../ 上一级" },
            ...(!this.runner.active ? [
              { value: "@new", label: "新建文本文件" },
              { value: "@mkdir", label: "新建目录" },
            ] : []),
            { value: "@search", label: "搜索文字" },
            ...(current !== "." && !this.runner.active
              ? [
                  {
                    value: "@directory",
                    label: "当前目录：重命名 / 复制 / 移动",
                  },
                ]
              : []),
            ...fileRows,
          ],
          selections.get(current),
          (value) => selections.set(current, value),
        );
        const choice = result?.value;
        if (!choice || choice === "@close") break;
        if (choice === "@up") {
          current = current === "." ? "." : dirname(current);
          continue;
        }
        if (choice === "@new" || choice === "@mkdir") {
          await this.dialogs.form(
            choice === "@new" ? "新建文本文件" : "新建目录",
            [
              {
                key: "path",
                label: "项目内相对路径",
                value: current === "." ? "" : current + sep,
              },
              ...(choice === "@new"
                ? [
                    {
                      key: "text",
                      label: "UTF-8 内容",
                      value: "",
                      multiline: true,
                    },
                  ]
                : []),
            ],
            async (values) => {
              if (choice === "@new")
                await files.create(values.path, values.text);
              else await files.mkdir(values.path);
            },
          );
          continue;
        }
        if (choice === "@search") {
          const values = await this.dialogs.form(
            "项目内文字搜索（区分大小写，最多 200 条）",
            [{ key: "needle", label: "文字（非正则）" }],
          );
          if (values) {
            const matches = await files.search(values.needle);
            await this.dialogs.text(
              "搜索结果",
              matches.length
                ? matches
                    .map((item) => `${item.path}:${item.line}: ${item.text}`)
                    .join("\n")
                : "没有匹配结果",
            );
          }
          continue;
        }
        const selected = choice === "@directory" ? current : choice;
        const info = await files.stat(selected);
        if (info.isDirectory() && choice !== "@directory" && !result.operations) {
          current = selected;
          continue;
        }
        const preview = async () => {
          try {
            const decoded = await decodeProjectImage(files, selected);
            if (this.disposed || this.quitting) return;
            await this.dialogs.image(selected, decoded.source, `${decoded.format.toUpperCase()} · ${decoded.width}×${decoded.height}${decoded.format === "gif" ? " · 首帧" : ""}`);
          } catch (error) {
            if (!this.disposed && !this.quitting) await this.dialogs.choice("图片预览失败", [
              { value: "back", label: "返回文件列表", description: String(error) },
            ]);
          }
        };
        if (!info.isDirectory() && isPreviewImage(selected) && !result.operations) {
          await preview();
          continue;
        }
        const operation = await this.dialogs.choice(selected, [
          ...(!info.isDirectory() && isPreviewImage(selected) ? [{ value: "preview", label: "只读图片预览" }] : []),
          ...(!info.isDirectory()
            ? [{ value: "edit", label: this.runner.active ? "只读 UTF-8 文本" : "编辑 UTF-8 文本" }]
            : []),
          ...(!this.runner.active ? [
            { value: "rename", label: "重命名" },
            { value: "copy", label: "复制" },
            { value: "move", label: "移动" },
          ] : []),
          { value: "properties", label: "属性" },
        ]);
        if (!operation) continue;
        if (operation === "preview") await preview();
        else if (operation === "edit") {
          const text = await files.read(selected);
          await this.dialogs.text(selected, text, this.runner.active ? undefined : (value) => files.write(selected, value, text));
        } else if (operation === "properties")
          await this.dialogs.text(
            "文件属性",
            `${selected}\n${info.isDirectory() ? "目录" : "文件"}\n字节：${info.size}\n修改：${new Date(Number(info.mtimeMs)).toISOString()}`,
          );
        else {
          await this.dialogs.form(
            "目标已存在时拒绝覆盖",
            [{ key: "path", label: "项目内目标相对路径", value: selected }],
            async (values) => {
              if (operation === "copy") await files.copy(selected, values.path);
              else await files.move(selected, values.path);
            },
          );
          if (choice === "@directory" && operation !== "copy")
            current = dirname(current);
        }
      }
    } finally {
      await this.loadProject(project);
    }
  }
  private async configureTask(choice: TaskChoice, capturedPath: string, client: HXClient): Promise<{ parameters: Record<string, string>; packConfiguration?: Record<string, unknown> } | undefined> {
    const command = choice.command;
    const configurationMode = choice.id.endsWith(":config");
    const parameters = { ...choice.defaults };
    const defaults = command.name === "pack" && !configurationMode
      ? await loadPackDefaults(capturedPath, this.document!) : new Map<string, { value: string; source: string }>();
    for (const [key, suggestion] of defaults) {
      const parameter = command.parameters.find((item) => item.name === key);
      if (!parameter || parameter.choices.length && !parameter.choices.includes(suggestion.value)) defaults.delete(key);
    }
    if (!configurationMode && choice.projectParameter) parameters[choice.projectParameter] = capturedPath;
    const controls = ["platform", "android.androidpacktype", "iscustom", "playground", "ssr", ...(choice.mode === "run" && choice.target === "web" ? ["browser"] : [])];
    for (const key of controls) {
      const parameter = taskParameters(choice, parameters).find((item) => item.name === key);
      if (!parameter) continue;
      let options = parameter.choices;
      if (command.name === "pack" && key === "platform" && !options.length && /多个平台.*英文逗号/.test(parameter.description)) {
        options = ["android", "ios", "android,ios"].filter((value) =>
          value.split(",").every((platform) => new RegExp(`\\b${platform}\\b`).test(parameter.description)));
      } else if (command.name === "pack" && key === "android.androidpacktype" && !options.length) {
        options = ["0", "1", "2", "3"].filter((value) => new RegExp(`(?:[:：，, ]|^)${value} `).test(parameter.description));
      }
      if (projectKind(this.document!.data) === "uni-app-x" && key === "android.androidpacktype") options = options.filter((value) => !["2", "3"].includes(value));
      if (!options.length) continue;
      const projectValue = defaults.get(key)?.value;
      const preferred = projectValue !== undefined && options.includes(projectValue) ? projectValue
        : key === "browser" && options.includes("Chrome") ? "Chrome"
        : parameter.default && options.includes(parameter.default) ? parameter.default
          : ["iscustom", "ssr"].includes(key) && options.includes("false") ? "false"
            : key === "playground" && options.includes("standard") ? "standard" : options[0];
      options = [preferred, ...options.filter((value) => value !== preferred)];
      const selected = await this.dialogs.choice(`${choice.label} · --${key}`, options.map((value) => ({
        value, label: (key === "playground" ? value === "standard" ? "标准运行基座" : value === "custom" ? "自定义云打包运行基座" : value
          : key === "iscustom" ? value === "true" ? "制作自定义调试基座（不是正式发行包）" : "正式应用安装包（不启用自定义基座）" : value) + (value === projectValue ? "（项目配置）" : value === parameter.default ? "（CLI 默认）" : ""),
        description: key === "android.androidpacktype" ? ({ "0": "自有证书：后续必须填写证书和密码（仅私有 JSON 传递）", "1": "公共证书", "2": "DCloud 老版证书，仅 classic", "3": "云端证书，仅 classic" } as Record<string, string>)[value] : parameter.description,
      })), `项目已锁定：${capturedPath}\n产物：${choice.artifact}\n前置：${choice.prerequisites}${key === "browser" ? "\n确认运行后会打开所选浏览器；端口使用项目 Web devServer 配置，多个项目请避免端口冲突。" : ""}`);
      if (selected === undefined) return;
      parameters[key] = selected;
    }
    const deviceParameter = command.parameters.find((parameter) => parameter.name === "deviceId");
    if (choice.mode === "run" && deviceParameter) {
      const deviceCommand = this.commands.find((item) => item.name === "devices list");
      const platform = choice.target === "app-android" ? "android" : choice.target === "app-ios" ? "ios-iPhone" : choice.target;
      const canQuery = deviceCommand?.parameters.some((parameter) => parameter.name === "platform" && (!parameter.choices.length || parameter.choices.includes(platform)));
      let output = "";
      while (true) {
        const selected = await this.dialogs.choice("运行目标设备", [
          { value: "first", label: "使用首个连接设备", description: "不传 deviceId；CLI 默认首个设备，可能不是期望的手机" },
          { value: "manual", label: "指定 deviceId", description: "填写设备序列号；设备查询结果仅显示，不猜测输出格式" },
          ...(canQuery ? [{ value: "query", label: "查询已连接设备", description: `执行只读 devices list --platform ${platform}` }] : []),
        ], output || `项目：${capturedPath}\n${deviceParameter.description}\n${choice.prerequisites}\n每个任务独立绑定本次设备；同时运行多台设备时建议指定 deviceId，避免都选中首个设备。`);
        if (!selected) return;
        if (selected === "query") {
          this.taskName = deviceCommand!.name;
          this.blockedNotice = false;
          this.log(`开始 CLI：${this.taskName} · 只读设备查询`);
          const running = client.run(deviceCommand!, { platform }, (line) => { output += line + "\n"; this.log(line); });
          this.updateStatus(); this.formatActions();
          try {
            const code = await running;
            output = `设备查询退出码：${code}\n${output}`;
            this.log(`CLI ${deviceCommand!.name} 结束，退出码 ${code}`);
          } catch (error) {
            if (!(error instanceof CLICancelledError)) throw error;
            output = "本地设备查询已取消，可重新查询、选择设备或返回；未执行运行任务。";
            this.log(output);
          } finally {
            this.taskName = "";
            this.blockedNotice = false;
            if (!this.disposed) { this.updateStatus(); this.formatActions(); }
          }
          if (this.disposed || this.quitting) return;
          continue;
        }
        if (selected === "manual") {
          const entered = await this.dialogs.form("指定目标设备", [{ key: "deviceId", label: "设备序列号（必填）", description: output || deviceParameter.description }],
            (values) => { if (!values.deviceId.trim()) throw new Error("请输入设备序列号"); });
          if (!entered) return;
          parameters.deviceId = entered.deviceId.trim();
        }
        break;
      }
    }
    let iosCertificate = false;
    if (command.name === "pack" && !configurationMode && (parameters.platform || "android").split(",").includes("ios") &&
      command.parameters.some((parameter) => parameter.name === "ios.certfile")) {
      const signing = await this.dialogs.choice("iOS 云打包 · 签名资料", [
        { value: "existing", label: "不提供自定义证书", description: "使用平台现有配置 / 自定义基座方式；仍需 iOS bundle，最终能否打包由 CLI 校验" },
        { value: "certificate", label: defaults.has("ios.certfile") ? "使用项目已保存证书（可修改）" : "填写自定义证书", description: "已有路径自动带入；证书密码仍需遮罩输入，仅通过私有 JSON 传递" },
      ]);
      if (!signing) return;
      iosCertificate = signing === "certificate";
    }
    let packConfiguration: Record<string, unknown> | undefined;
    const required = new Set(taskRequiredParameters(choice, parameters));
    if (iosCertificate) for (const key of ["ios.profile", "ios.certfile", "ios.certpassword"]) required.add(key);
    const entries: Entry[] = taskParameters(choice, parameters).filter((parameter) =>
      !(parameter.name in parameters) &&
      !(choice.mode === "run" && parameter.name === "deviceId" && !parameter.required) &&
      !(command.name === "pack" && /^ios\.(profile|certfile|certpassword)$/.test(parameter.name) && !iosCertificate && !parameter.required) &&
      !(projectKind(this.document!.data) === "uni-app-x" && !parameter.required && /仅.*uni-app 项目/.test(parameter.description) && !/uni-app x/.test(parameter.description))
    ).map((parameter) => ({
      key: parameter.name, label: "--" + parameter.name,
      description: parameter.description + (parameter.choices.length ? "\n允许：" + parameter.choices.join(" / ") : "") +
        (parameter.required || required.has(parameter.name) ? "\n当前模式必填；请填写后提交整份参数。" : "\n可选；留空或选择默认表示省略参数。") +
        (defaults.has(parameter.name) ? "\n来源：" + defaults.get(parameter.name)!.source + "（可修改）" : ""),
      value: defaults.get(parameter.name)?.value ?? "",
      required: parameter.required || required.has(parameter.name),
      choices: parameter.choices,
      allowOmit: !parameter.required && !required.has(parameter.name),
      defaultValue: parameter.default,
      secret: /password|secret|token|privatekey/i.test(parameter.name) || parameter.description.includes("密码"),
    })).sort((a, b) => Number(b.required) - Number(a.required));
    // Mode, target, platform and base are selected above, never editable as raw CLI switches.
    const validate = async (values: Record<string, string>) => {
      const submitted = { ...parameters, ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "")) };
      validateTask(choice, submitted);
      if (iosCertificate)
        for (const key of ["ios.profile", "ios.certfile", "ios.certpassword"])
          if (command.parameters.some((parameter) => parameter.name === key) && !submitted[key]?.trim()) throw new Error(`自定义 iOS 证书必须填写 --${key}`);
      if (configurationMode) {
        packConfiguration = await client.preparePackConfiguration(submitted.config, capturedPath);
        const flattened: Record<string, string> = {};
        for (const parameter of command.parameters) {
          if (parameter.name === "config") continue;
          let value: unknown = packConfiguration;
          for (const part of parameter.name.split("."))
            value = value && typeof value === "object" ? (value as Record<string, unknown>)[part === "storepassword" ? "storePassword" : part] : undefined;
          if (value !== undefined && value !== null) flattened[parameter.name] = String(value);
        }
        validateTask({ ...choice, id: choice.id.replace(/:config$/, ":cloud") }, flattened);
      }
      client.arguments(command, submitted, true);
    };
    let values: Record<string, string> | undefined;
    if (entries.length) values = await this.dialogs.form(`${choice.label} · 参数 · 项目已锁定 ${capturedPath}`, entries, validate);
    else { await validate({}); values = {}; }
    if (!values) return;
    Object.assign(parameters, Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "")));
    return { parameters, packConfiguration };
  }
  private async command(kind?: TaskKind, capturedPath = this.project?.path): Promise<void> {
    if (!(await this.unsaved())) return;
    if (!this.client || !this.commands.length) await this.connect();
    if (!this.client || !this.commands.length) {
      const recover = await this.dialogs.choice("CLI 未连接或没有可用命令；可配置 CLI 后重试", [
        { value: "cancel", label: "返回工作区" },
        { value: "cli", label: "选择 / 配置 CLI", description: "验证可执行文件后重新发现命令" },
      ]);
      if (recover === "cli") await this.configureCli();
      return;
    }
    const client = this.client;
    let choice: TaskChoice | undefined;
    let command: Command;
    let parameters: Record<string, string>;
    let packConfiguration: Record<string, unknown> | undefined;
    if (kind) {
      const choices = taskChoices(this.commands, kind, projectKind(this.document!.data));
      const documented = kind === "run"
        ? ["app-android", "app-ios", "app-harmony", "mp-harmony", "web", "mp-weixin", "mp-alipay", "mp-baidu", "mp-toutiao", "mp-qq", "mp-kuaishou", "mp-lark", "mp-jd", "mp-xhs", "mp-360", "quickapp-webview", "quickapp-webview-huawei", "quickapp-webview-union"]
        : ["App 云打包", "app", "app-android", "app-ios", "app-harmony", "mp-harmony", "web", "mp-weixin", "mp-alipay", "status", "cancel"];
      const targets = [...new Set([...choices.map((item) => item.target), ...documented])];
      platformSelection: while (true) {
        const target = await this.dialogs.choice(`${kind === "run" ? "运行 / 开发编译" : "发行 / 打包"} · 选择平台`, [
          ...targets.map((target) => ({ value: target, label: target === "status" ? "查看云打包状态" : target === "cancel" ? "取消远端云打包" : target,
            description: choices.some((item) => item.target === target) ? "选择后查看实际模式、产物和前置条件" : "当前 CLI 未发现此目标能力；可换 CLI 或查看高级任务" })),
          { value: "@advanced", label: "其它能力 → 高级 CLI", description: "动态 help 的其它任务；仍受无 GUI 与凭据安全限制" },
        ], `已捕获项目：${capturedPath}\n只执行当前 CLI 已发现的能力；实际运行、开发编译、原生资源与最终安装包彼此不同。`);
        if (!target) return;
        if (target === "@advanced") { await this.command(undefined, capturedPath); return; }
        const modes = choices.filter((item) => item.target === target);
        if (!modes.length) {
          const back = await this.dialogs.choice("此版本未发现对应任务能力", [{ value: "back", label: "返回平台；不执行", description: "不会构造不存在的命令；可在设置切换 CLI 后重新发现。" }]);
          if (!back) return;
          continue platformSelection;
        }
        while (true) {
          const id = await this.dialogs.choice(`${target} · 选择模式 / 产物`, [
            ...modes.map((item) => ({ value: item.id, label: item.label, description: item.description })),
            { value: "@back", label: "← 返回平台" },
          ]);
          if (!id) return;
          if (id === "@back") continue platformSelection;
          choice = modes.find((item) => item.id === id);
          if (!choice) return;
          if (choice.unavailable || !choice.projectParameter) {
            const back = await this.dialogs.choice("当前模式不可执行", [{ value: "back", label: "返回模式；不执行",
              description: choice.unavailable ?? "无法绑定捕获项目：命令未提供 project / projectPath / prj；path 是可能的输出目录，不能冒充项目选择器。" }]);
            if (!back) return;
            continue;
          }
          break;
        }
        command = choice.command;
        const prepared = await this.configureTask(choice, capturedPath!, client);
        if (!prepared) return;
        ({ parameters, packConfiguration } = prepared);
        break;
      }
    } else {
      const selected = await this.dialogs.choice("高级 CLI 任务（云操作可能产生费用）", this.commands.map((command) => ({ value: command.name, label: command.name, description: command.description })), `目标项目：${capturedPath ?? "无显式项目"}\n输入命令名称或说明筛选；参数与最终执行仍需确认。`, true);
      if (!selected) return;
      command = this.commands.find((item) => item.name === selected)!;
      const values = await this.dialogs.form(selected, command.parameters.map((parameter) => ({
        key: parameter.name, label: "--" + parameter.name,
        description: parameter.description + (parameter.required ? "\n必填参数；请填写后提交。" : "\n可选；留空省略，无值开关填 @flag。"),
        value: parameter.name === "ui" ? "false" : ["project", "projectPath", "prj"].includes(parameter.name) ? capturedPath : "",
        required: parameter.required,
        choices: parameter.choices,
        allowOmit: !parameter.required,
        defaultValue: parameter.default,
        secret: /password|secret|token|privatekey/i.test(parameter.name) || parameter.description.includes("密码"),
      })), (values) => { client.arguments(command, Object.fromEntries(Object.entries(values).filter(([, value]) => value !== "")), true); });
      if (!values) return;
      parameters = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
    }
    const mode = choice ? taskMode(choice, parameters) : undefined;
    const webRunning = command.name === "launch web" && parameters.compile === "false";
    const modeLabel = mode === "compile" ? "开发仅编译（不是生产发行或实际运行）" : webRunning ? "Web 开发运行（打开浏览器）" : mode === "run" ? "设备运行" : mode === "manage" ? "云打包管理" : choice?.label ?? "高级 CLI";
    const customBase = packConfiguration?.iscustom === true || packConfiguration?.iscustom === "true" || parameters.iscustom === "true";
    const artifact = command.name === "pack" ? customBase ? "自定义云调试基座 APK / IPA（不是正式发行包）" : "正式应用安装包 APK / IPA（云任务结果为准）" : choice?.artifact;
    const finalPath = packConfiguration ? capturedPath : ["project", "projectPath", "prj"].map((key) => parameters[key]).filter(Boolean).join(" / ");
    let target: string | undefined;
    if (command.name.startsWith("launch ") || command.name.startsWith("logcat ")) {
      const platform = command.name.split(" ")[1];
      if (platform === "web") {
        const webRoot = this.document && projectKind(this.document.data) === "uni-app-x" ? "web" : "h5";
        const configuredPort = finalPath === this.project?.path ? this.document?.get([webRoot, "devServer", "port"]) : undefined;
        const browser = parameters.browser || command.parameters.find((parameter) => parameter.name === "browser")?.default || "CLI 默认浏览器";
        target = parameters.compile === "true" ? "web · 仅编译"
          : `web · ${browser} · ${configuredPort === undefined ? "端口以项目配置/日志为准" : "配置端口 " + String(configuredPort)}`;
      } else {
        target = `${platform} · ${parameters.deviceId ? "设备 " + parameters.deviceId : "首个连接设备"}${parameters.iosTarget ? " · " + parameters.iosTarget : ""}`;
      }
    }
    const visibleParameters = Object.entries(parameters).map(([key, value]) =>
      `--${key} ${/password|secret|token|privatekey/i.test(key) || command.parameters.find((parameter) => parameter.name === key)?.description.includes("密码") ? "〈私密值〉" : value}`).join("\n");
    const summary = `${modeLabel}：${command.name}\n目标项目：${finalPath || "无显式项目参数"}\n${target ? "运行实例：" + target + "\n" : ""}${choice ? `产物：${artifact}\n前置条件：${choice.prerequisites}\n风险：${choice.risk}\n` : "高级命令：产物与副作用以当前 CLI help 及日志为准；云操作可能收费。\n"}最终参数：\n${visibleParameters || "无"}\n${packConfiguration ? `JSON 已安全读取，project 已绑定；确认后只传私有快照，不重新读取源文件。平台：${String(packConfiguration.platform ?? "android（默认）")}\n` : ""}${webRunning ? "将启动 Web 开发运行并打开所选浏览器。端口沿用项目配置；同一项目/设备的并发构建或部署可能争用上游资源。\n" : "不会打开 IDE、浏览器、开发者工具或模拟器。\n"}输出位置以 CLI 日志为准；凭据不记录。Ctrl+K 仅取消本地进程，不关闭浏览器、不保证设备应用停止，也不取消远端任务。`;
    if (!(await this.dialogs.confirm(summary))) return;
    if (choice && !packConfiguration && parameters[choice.projectParameter!] !== capturedPath) throw new Error("任务目标项目发生变化，已拒绝执行");
    if (choice) validateTask(choice, parameters);
    client.arguments(command, parameters, true);
    this.blockedNotice = false;
    const task = this.runner.start(client, command, parameters,
      { allowSensitive: true, packConfiguration, project: capturedPath },
      { label: `${command.name} · ${modeLabel}`, project: finalPath || capturedPath, target });
    this.logPositions.set(this.selectedTaskId, this.fullLogList.getSelectedIndex());
    this.selectedTaskId = task.id;
    this.refreshTasks();
    this.switchPage(2);
  }
}
