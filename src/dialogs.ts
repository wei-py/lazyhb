import {
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  ImageRenderable,
  ScrollBoxRenderable,
  resolveImageRenderProtocol,
  type CliRenderer,
  type KeyEvent,
  type PasteEvent,
  type Renderable,
  type TextOptions,
} from "@opentui/core";
import { CompactSelectRenderable } from "./select.js";
import { readdir, lstat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { themes, DEFAULT_THEME, type Theme } from "./theme.js";

export interface Entry {
  key: string;
  label: string;
  value?: string;
  description?: string;
  multiline?: boolean;
  secret?: boolean;
}
export interface FileChoiceRow {
  value: string;
  label: string;
  loadSource?: () => Promise<Uint8Array>;
  typeLabel?: string;
}
interface Modal {
  box: BoxRenderable;
  focus: Renderable[];
  cancel(force?: boolean): void;
  submit(): void;
  key?(key: KeyEvent): boolean;
  refresh?(): void;
}

/** Only asterisks enter OpenTUI's render buffer; the credential stays in JS memory. */
class MaskedInput extends TextRenderable {
  private characters: string[] = [];
  private cursor = 0;
  private allSelected = false;
  get value(): string {
    return this.characters.join("");
  }
  set value(value: string) {
    this.characters = Array.from(value);
    this.cursor = this.characters.length;
    this.allSelected = false;
    this.refresh();
  }
  private refresh(): void {
    this.content = this.allSelected
      ? "[" + "*".repeat(this.characters.length) + "]"
      : "*".repeat(this.cursor) +
        "│" +
        "*".repeat(this.characters.length - this.cursor);
  }
  handlePaste(event: PasteEvent): void {
    event.preventDefault();
    this.insert(new TextDecoder().decode(event.bytes));
  }
  private insert(value: string): void {
    const characters = Array.from(value.replace(/[\x00-\x1f\x7f]/g, ""));
    if (
      (this.allSelected ? 0 : this.characters.length) + characters.length >
      16384
    )
      return;
    if (this.allSelected) {
      this.characters = [];
      this.cursor = 0;
      this.allSelected = false;
    }
    this.characters.splice(this.cursor, 0, ...characters);
    this.cursor += characters.length;
    this.refresh();
  }
  handleKeyPress(key: KeyEvent): boolean {
    if (key.ctrl && key.name === "a") {
      this.allSelected = true;
      this.refresh();
      return true;
    }
    if (this.allSelected) {
      if (
        ["backspace", "delete"].includes(key.name) ||
        (key.ctrl && key.name === "u")
      ) {
        this.characters = [];
        this.cursor = 0;
      } else if (["left", "home"].includes(key.name)) this.cursor = 0;
      else if (["right", "end"].includes(key.name))
        this.cursor = this.characters.length;
      else if (
        !key.ctrl &&
        !key.meta &&
        !key.option &&
        !/[\x00-\x1f\x7f]/.test(key.sequence)
      ) {
        this.insert(key.sequence);
        return true;
      } else return false;
      this.allSelected = false;
      this.refresh();
      return true;
    }
    if (key.name === "left") this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === "right")
      this.cursor = Math.min(this.characters.length, this.cursor + 1);
    else if (key.name === "home") this.cursor = 0;
    else if (key.name === "end") this.cursor = this.characters.length;
    else if (key.name === "backspace") {
      if (this.cursor) this.characters.splice(--this.cursor, 1);
    } else if (key.name === "delete") this.characters.splice(this.cursor, 1);
    else if (key.ctrl && key.name === "u") {
      this.characters = [];
      this.cursor = 0;
    } else if (
      !key.ctrl &&
      !key.meta &&
      !key.option &&
      !/[\x00-\x1f\x7f]/.test(key.sequence)
    ) {
      this.insert(key.sequence);
      return true;
    } else return false;
    this.refresh();
    return true;
  }
  protected destroyOwnedResources(): void {
    this.characters = [];
    super.destroyOwnedResources();
  }
}

export class Dialogs {
  private modal?: Modal;
  private themeUpdates: (() => void)[] = [];
  constructor(
    private renderer: CliRenderer,
    private restoreFocus: () => void,
    private theme: Theme = themes[DEFAULT_THEME],
  ) {}
  setTheme(theme: Theme): void {
    this.theme = theme;
    if (this.modal) {
      this.modal.box.backgroundColor = theme.surface;
      this.modal.box.borderColor = theme.accent;
      this.modal.box.titleColor = theme.accent;
      for (const update of this.themeUpdates) update();
      this.modal.refresh?.();
    }
  }
  get active(): boolean {
    return !!this.modal;
  }
  cancelActive(): void {
    this.modal?.cancel(true);
  }
  handleKey(key: KeyEvent): boolean {
    const modal = this.modal;
    if (!modal) return false;
    if (key.name === "escape") {
      key.preventDefault();
      modal.cancel();
    } else if (key.name === "tab") {
      key.preventDefault();
      const at = modal.focus.findIndex((item) => item.focused);
      modal.focus[
        (at + (key.shift ? -1 : 1) + modal.focus.length) % modal.focus.length
      ]?.focus();
    } else if (key.ctrl && key.name === "s") {
      key.preventDefault();
      modal.submit();
    } else if (modal.key?.(key)) key.preventDefault();
    return true;
  }
  private createText(
    options: TextOptions,
    foreground: "foreground" | "muted" | "accent" | "error",
  ): TextRenderable {
    const text = new TextRenderable(this.renderer, {
      ...options, fg: this.theme[foreground], bg: this.theme.surface,
    });
    this.themeUpdates.push(() => {
      text.fg = this.theme[foreground];
      text.bg = this.theme.surface;
    });
    return text;
  }
  private frame(title: string): { box: BoxRenderable; error: TextRenderable } {
    if (this.modal) throw new Error("A dialog is already open");
    this.themeUpdates = [];
    const box = new BoxRenderable(this.renderer, {
      position: "absolute",
      top: "5%",
      left: "5%",
      width: "90%",
      height: "90%",
      border: true,
      borderColor: this.theme.accent,
      title,
      titleColor: this.theme.accent,
      backgroundColor: this.theme.surface,
      padding: 1,
      flexDirection: "column",
      zIndex: 100,
    });
    const error = this.createText({ content: "", height: 3 }, "error");
    this.renderer.root.add(box);
    return { box, error };
  }
  private close(): void {
    const modal = this.modal;
    this.modal = undefined;
    this.themeUpdates = [];
    modal?.box.destroyRecursively();
    this.restoreFocus();
  }
  private button(
    box: BoxRenderable,
    label: string,
    action: () => void,
  ): Renderable {
    const button = this.createText({
      content: ` [ ${label} ] `,
      height: 1,
      onMouseDown: () => action(),
      onKeyDown: (key) => {
        if (key.name === "return") {
          key.preventDefault();
          action();
        }
      },
    }, "accent");
    button.focusable = true;
    box.add(button);
    return button;
  }
  async choice<T extends string>(
    title: string,
    options: { value: T; label: string; description?: string }[],
    summary?: string,
  ): Promise<T | undefined> {
    if (!options.length) return undefined;
    const { promise, resolve: finish } = Promise.withResolvers<T | undefined>();
    const { box, error } = this.frame(title);
    let summaryView: ScrollBoxRenderable | undefined;
    if (summary) {
      summaryView = new ScrollBoxRenderable(this.renderer, {
        id: "choice-summary", height: "35%", minHeight: 3, flexShrink: 1,
        scrollX: false, scrollY: true, contentOptions: { flexDirection: "column" },
      });
      summaryView.focusable = true;
      summaryView.add(this.createText({ content: summary, width: "100%", flexShrink: 0, wrapMode: "word" }, "foreground"));
      this.themeUpdates.push(() => {
        summaryView!.scrollbarOptions = { trackOptions: { backgroundColor: this.theme.border, foregroundColor: this.theme.accent } };
      });
      box.add(summaryView);
    }
    const list = new CompactSelectRenderable(this.renderer, {
      options: options.map((item) => ({
        name: item.label,
        description: item.description ?? "",
        value: item.value,
      })),
      flexGrow: 1, minHeight: Math.min(4, options.length * 2),
      showDescription: true,
      showScrollIndicator: true,
      backgroundColor: this.theme.surface,
      textColor: this.theme.foreground,
      focusedBackgroundColor: this.theme.surface,
      focusedTextColor: this.theme.foreground,
      selectedBackgroundColor: this.theme.selectedBackground,
      selectedTextColor: this.theme.selectedForeground,
      descriptionColor: this.theme.muted,
      selectedDescriptionColor: this.theme.selectedForeground,
    });
    this.themeUpdates.push(() => {
      list.backgroundColor = this.theme.surface;
      list.textColor = this.theme.foreground;
      list.focusedBackgroundColor = this.theme.surface;
      list.focusedTextColor = this.theme.foreground;
      list.selectedBackgroundColor = this.theme.selectedBackground;
      list.selectedTextColor = this.theme.selectedForeground;
      list.descriptionColor = this.theme.muted;
      list.selectedDescriptionColor = this.theme.selectedForeground;
    });
    box.add(list);
    box.add(error);
    const submit = () => {
      const value = list.getSelectedOption()?.value as T | undefined;
      this.close();
      finish(value);
    };
    list.on("itemSelected", submit);
    list.onMouseDown = (event) => {
      if (event.button !== 0 || event.x < list.x || event.x >= list.x + list.width) return;
      // This dialog uses two fixed rows per item (name + description), no font or spacing.
      // OpenTUI 0.7 Select centers its viewport, but has no mouse row selection.
      const row = Math.floor((event.y - list.y) / 2);
      const capacity = Math.max(1, Math.floor(list.height / 2));
      if (row < 0 || row >= capacity) return;
      const offset = Math.max(0, Math.min(list.getSelectedIndex() - Math.floor(capacity / 2), list.options.length - capacity));
      const index = offset + row;
      if (index >= list.options.length) return;
      event.preventDefault(); event.stopPropagation();
      list.setSelectedIndex(index);
      list.focus();
    };
    box.add(
      this.createText({
        content: summary ? "↑↓ 选择 · Enter 确认 · Tab 摘要 · PgUp/PgDn 滚动 · Esc 取消" : "↑↓ 选择 · Enter 确认 · Escape 取消",
        height: 1,
      }, "muted"),
    );
    const ok = this.button(box, "确认", submit);
    this.modal = {
      box,
      focus: summaryView ? [list, summaryView, ok] : [list, ok],
      submit,
      key: (key) => {
        if (!summaryView || (!summaryView.focused && !["pageup", "pagedown"].includes(key.name))) return false;
        const amount = ["up", "k"].includes(key.name) ? -1 : ["down", "j"].includes(key.name) ? 1
          : key.name === "pageup" ? -Math.max(1, summaryView.viewport.height - 1)
            : key.name === "pagedown" ? Math.max(1, summaryView.viewport.height - 1) : 0;
        if (amount) { summaryView.scrollBy(amount); return true; }
        if (key.name === "home" || key.name === "end") {
          summaryView.scrollTo(key.name === "home" ? 0 : summaryView.scrollHeight); return true;
        }
        return false;
      },
      cancel: () => {
        this.close();
        finish(undefined);
      },
    };
    list.focus();
    return promise;
  }
  async fileChoice(
    title: string,
    options: FileChoiceRow[],
    selected: string | undefined,
    onSelection: (value: string) => void,
  ): Promise<{ value: string; operations: boolean } | undefined> {
    if (!options.length) return undefined;
    const { promise, resolve: finish } = Promise.withResolvers<{ value: string; operations: boolean } | undefined>();
    const { box } = this.frame(title);
    const list = new BoxRenderable(this.renderer, {
      id: "file-browser-list", flexGrow: 1, minHeight: 1, flexDirection: "column", overflow: "hidden",
    });
    list.focusable = true;
    box.add(list);
    let index = Math.max(0, options.findIndex((item) => item.value === selected));
    let offset = 0;
    const rows: { box: BoxRenderable; image?: ImageRenderable; type: TextRenderable; text: TextRenderable; at: number; item?: FileChoiceRow }[] = [];
    const nativeProtocol = () => {
      const caps = this.renderer.capabilities;
      const resolution = this.renderer.resolution;
      const pixels = !!resolution && resolution.width > 0 && resolution.height > 0;
      const chosen = resolveImageRenderProtocol("auto", caps, pixels);
      if (!caps || caps.multiplexer === "tmux") return undefined;
      return chosen === "kitty" && caps.kitty_graphics ? "kitty" as const
        : chosen === "sixel" && caps.sixel && pixels ? "sixel" as const : undefined;
    };
    const draw = () => {
      if (this.modal?.box !== box) return;
      const protocol = nativeProtocol();
      const capacity = Math.max(1, Math.floor(list.height));
      if (index < offset) offset = index;
      if (index >= offset + capacity) offset = index - capacity + 1;
      offset = Math.max(0, Math.min(offset, options.length - capacity));
      while (rows.length < Math.min(capacity, options.length)) {
        const row = new BoxRenderable(this.renderer, {
          id: `file-browser-row-${rows.length}`, height: 1, flexShrink: 0, flexDirection: "row",
        });
        const type = new TextRenderable(this.renderer, { width: 7, height: 1, flexShrink: 0, wrapMode: "none" });
        const text = new TextRenderable(this.renderer, { height: 1, flexGrow: 1, minWidth: 0, wrapMode: "none" });
        const binding: typeof rows[number] = { box: row, type, text, at: 0 };
        row.onMouseDown = (event) => {
          event.preventDefault(); event.stopPropagation(); select(binding.at); submit();
        };
        const indicator = new BoxRenderable(this.renderer, { width: 7, height: 1, flexShrink: 0 });
        indicator.add(type);
        row.add(indicator); row.add(text); list.add(row); rows.push(binding);
      }
      rows.forEach((row, slot) => {
        if (!protocol && row.image) {
          row.image.source = undefined;
          row.image.destroyRecursively();
          row.image = undefined;
          row.item = undefined;
        }
        const at = offset + slot;
        row.box.visible = slot < capacity && at < options.length;
        if (!row.box.visible) {
          if (row.image) row.image.source = undefined;
          row.item = undefined;
          return;
        }
        row.at = at;
        const item = options[at];
        row.box.backgroundColor = at === index ? this.theme.selectedBackground : this.theme.surface;
        row.text.fg = row.type.fg = at === index ? this.theme.selectedForeground : this.theme.foreground;
        row.text.content = item.label;
        row.type.content = item.typeLabel ?? "";
        if (!protocol || !item.loadSource) {
          if (row.image) {
            row.image.source = undefined;
            row.image.destroyRecursively();
            row.image = undefined;
          }
          row.type.visible = true;
          row.item = undefined;
          return;
        }
        if (!row.image) {
          row.image = new ImageRenderable(this.renderer, {
            id: `file-browser-icon-${slot}`, width: 2, height: 1, flexShrink: 0,
            fit: "fit", protocol,
            onError: () => {
              if (row.image) {
                row.image.source = undefined;
                row.image.visible = false;
                row.type.visible = true;
              }
            },
          });
          row.type.parent!.insertBefore(row.image, row.type);
        }
        row.type.visible = false;
        row.image.protocol = protocol;
        if (row.item !== item) {
          row.item = item;
          row.image.source = undefined;
          row.image.visible = true;
          const image = row.image;
          void item.loadSource().then(source => {
            if (this.modal?.box === box && row.item === item && row.image === image) image.source = source;
          }).catch(() => {
            if (this.modal?.box === box && row.item === item && row.image === image) {
              image.source = undefined;
              image.visible = false;
              row.type.visible = true;
            }
          });
        }
      });
    };
    const select = (next: number) => {
      index = Math.max(0, Math.min(options.length - 1, next));
      onSelection(options[index].value);
      draw();
    };
    const submit = (operations = false) => {
      const value = options[index].value;
      this.close();
      finish({ value, operations });
    };
    list.onSizeChange = draw;
    list.onMouseScroll = (event) => {
      if (event.scroll?.direction === "up" || event.scroll?.direction === "down") {
        event.preventDefault(); event.stopPropagation();
        select(index + (event.scroll.direction === "up" ? -1 : 1) * 3);
      }
    };
    box.add(this.createText({
      content: "↑↓/jk/Home/End 选择 · Enter/l/点击 打开 · o 操作菜单 · ←/h/Backspace 上级 · Esc 返回配置", height: 2,
    }, "muted"));
    this.modal = {
      box, focus: [list], submit: () => submit(),
      refresh: draw,
      cancel: () => { this.close(); finish(undefined); },
      key: (key) => {
        if (["up", "down", "j", "k", "home", "end", "pageup", "pagedown"].includes(key.name)) {
          const page = Math.max(1, Math.floor(list.height) - 1);
          select(key.name === "home" ? 0 : key.name === "end" ? options.length - 1
            : index + (["up", "pageup", "k"].includes(key.name) ? -1 : 1) * (key.name.startsWith("page") ? page : 1));
          return true;
        }
        if (key.name === "return" || key.name === "l" || key.name === "o") { submit(key.name === "o"); return true; }
        if (key.name === "left" || key.name === "h" || key.name === "backspace") {
          this.close(); finish({ value: "@up", operations: false }); return true;
        }
        return false;
      },
    };
    list.focus();
    // Layout must be resolved before restoring a selection below the viewport.
    const reveal = () => { if (this.modal?.box === box) select(index); };
    this.renderer.once("frame", reveal);
    box.once("destroyed", () => this.renderer.off("frame", reveal));
    this.renderer.on("capabilities", draw);
    box.once("destroyed", () => this.renderer.off("capabilities", draw));
    return promise;
  }
  async image(title: string, source: Uint8Array, description: string): Promise<void> {
    const { promise, resolve: finish } = Promise.withResolvers<void>();
    const { box, error } = this.frame(title);
    const image = new ImageRenderable(this.renderer, {
      id: "image-preview", source, flexGrow: 1, minHeight: 1, fit: "fit", protocol: "auto",
      onError: (reason) => {
        if (this.modal?.box === box) error.content = `图像绘制失败：${String(reason)}`;
      },
    });
    box.add(image);
    box.add(this.createText({ content: description + " · 只读 · Esc 返回文件列表", height: 2 }, "muted"));
    box.add(error);
    const close = () => { this.close(); finish(); };
    const back = this.button(box, "返回文件列表", close);
    this.modal = { box, focus: [back], submit: close, cancel: close };
    back.focus();
    return promise;
  }
  async confirm(title: string): Promise<boolean> {
    return (
      (await this.choice("确认操作", [
        { value: "no", label: "取消 / 否" },
        { value: "yes", label: "确认 / 是" },
      ], title)) === "yes"
    );
  }
  async form(
    title: string,
    entries: Entry[],
    validate?: (values: Record<string, string>) => void | Promise<void>,
  ): Promise<Record<string, string> | undefined> {
    const { promise, resolve: finish } = Promise.withResolvers<
      Record<string, string> | undefined
    >();
    const { box, error } = this.frame(title);
    let index = 0;
    const label = this.createText({ content: "", height: 5 }, "foreground");
    const editor = new TextareaRenderable(this.renderer, {
      initialValue: "",
      flexGrow: 1,
      backgroundColor: this.theme.inputBackground,
      textColor: this.theme.foreground,
      focusedBackgroundColor: this.theme.inputBackground,
      focusedTextColor: this.theme.foreground,
      selectionBg: this.theme.selectedBackground,
      selectionFg: this.theme.selectedForeground,
      cursorColor: this.theme.accent,
      wrapMode: "word",
      keyBindings: [{ name: "a", ctrl: true, action: "select-all" }],
    });
    const password = new MaskedInput(this.renderer, {
      content: "",
      height: 2,
      fg: this.theme.foreground,
      bg: this.theme.inputBackground,
    });
    this.themeUpdates.push(() => {
      editor.backgroundColor = this.theme.inputBackground;
      editor.textColor = this.theme.foreground;
      editor.focusedBackgroundColor = this.theme.inputBackground;
      editor.focusedTextColor = this.theme.foreground;
      editor.selectionBg = this.theme.selectedBackground;
      editor.selectionFg = this.theme.selectedForeground;
      editor.cursorColor = this.theme.accent;
      password.fg = this.theme.foreground;
      password.bg = this.theme.inputBackground;
    });
    password.focusable = true;
    password.visible = false;
    box.add(label);
    box.add(editor);
    box.add(password);
    box.add(error);
    const values = Object.fromEntries(
      entries.map((entry) => [entry.key, entry.value ?? ""]),
    );
    const store = () => {
      const entry = entries[index];
      if (entry)
        values[entry.key] = entry.secret ? password.value : editor.plainText;
    };
    const show = () => {
      const entry = entries[index];
      label.content = entry
        ? `${index + 1}/${entries.length} ${entry.label}\n${entry.description ?? ""}${entry.secret ? "\n凭据已遮罩；Ctrl+U 清空，支持粘贴" : ""}`
        : "无参数，Ctrl+S 继续";
      editor.visible = !entry?.secret;
      password.visible = !!entry?.secret;
      editor.setText(entry && !entry.secret ? values[entry.key] : "");
      password.value = entry?.secret ? values[entry.key] : "";
    };
    const focusEditor = () =>
      (entries[index]?.secret ? password : editor).focus();
    const step = (delta: number) => {
      if (!entries.length) return;
      store();
      index = (index + delta + entries.length) % entries.length;
      show();
      if (this.modal)
        this.modal.focus[0] = entries[index].secret ? password : editor;
      focusEditor();
    };
    let submitting = false;
    let closed = false;
    const submit = async () => {
      if (submitting || closed) return;
      store();
      submitting = true;
      try {
        await validate?.(values);
        if (closed || this.modal?.box !== box) return;
        closed = true;
        this.close();
        finish(values);
      } catch (cause) {
        if (closed || this.modal?.box !== box) return;
        error.content = entries.some(
          (entry) => entry.secret && values[entry.key],
        )
          ? "字段值无效或操作失败；请检查类型、枚举和必填项。凭据不会显示。"
          : String(cause);
      } finally {
        submitting = false;
      }
    };
    box.add(
      this.createText({
        content:
          "Alt+↑/↓ 上/下一字段 · Tab 切换按钮 · Ctrl+S 应用 · Escape 取消",
        height: 2,
      }, "muted"),
    );
    const focus = [
      editor,
      this.button(box, "上一字段", () => step(-1)),
      this.button(box, "下一字段", () => step(1)),
      this.button(box, "应用", () => {
        void submit();
      }),
    ];
    this.modal = {
      box,
      focus,
      submit: () => {
        void submit();
      },
      cancel: (force = false) => {
        if (force || !submitting) {
          closed = true;
          this.close();
          finish(undefined);
        }
      },
      key: (key) => {
        if (
          (key.meta || key.option) &&
          (key.name === "up" || key.name === "down")
        ) {
          step(key.name === "up" ? -1 : 1);
          return true;
        }
        return false;
      },
    };
    show();
    this.modal.focus[0] = entries[index]?.secret ? password : editor;
    focusEditor();
    return promise;
  }
  async text(
    title: string,
    initial: string,
    validate?: (text: string) => void | Promise<void>,
  ): Promise<string | undefined> {
    return (
      await this.form(
        title,
        [
          {
            key: "text",
            label: "UTF-8 文本 / JSON5",
            value: initial,
            multiline: true,
          },
        ],
        (values) => validate?.(values.text),
      )
    )?.text;
  }
  async path(
    title: string,
    initial: string,
    directory = false,
  ): Promise<string | undefined> {
    let current = resolve(initial);
    try {
      if (!(await lstat(current)).isDirectory()) current = dirname(current);
    } catch {
      current = dirname(current);
    }
    while (true) {
      const names = await readdir(current, { withFileTypes: true });
      const selection = await this.choice(title + ": " + current, [
        { value: "@input", label: "输入绝对路径…" },
        ...(directory ? [{ value: "@select", label: "选择当前目录" }] : []),
        { value: "@parent", label: "../ 上一级" },
        ...names
          .filter((entry) => !entry.isSymbolicLink())
          .sort(
            (a, b) =>
              Number(b.isDirectory()) - Number(a.isDirectory()) ||
              a.name.localeCompare(b.name),
          )
          .map((entry) => ({
            value: entry.name,
            label: `${entry.isDirectory() ? "▸ " : "  "}${entry.name}`,
          })),
      ]);
      if (selection === undefined) return undefined;
      if (selection === "@select") return current;
      if (selection === "@parent") {
        current = dirname(current);
        continue;
      }
      let candidate: string;
      if (selection === "@input") {
        const value = await this.form("输入路径", [
          { key: "path", label: directory ? "目录" : "文件", value: current },
        ]);
        if (!value) continue;
        candidate = resolve(
          value.path.startsWith("~/")
            ? join(homedir(), value.path.slice(2))
            : value.path,
        );
      } else candidate = join(current, selection);
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error("不接受符号链接或 junction");
      if (directory && selection === "@input" && info.isDirectory())
        return candidate;
      if (info.isDirectory()) current = candidate;
      else if (!directory && info.isFile()) return candidate;
      else throw new Error("路径类型不匹配");
    }
  }
}
