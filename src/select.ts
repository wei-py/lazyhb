import {
  SelectRenderable,
  type RenderContext,
  type SelectOption,
  type SelectRenderableOptions,
} from "@opentui/core";

// OpenTUI 0.7 only allows hiding its fixed selection glyph. Keep its two-column
// gutter in option text so layout, descriptions, scrolling and colors stay intact.
export class CompactSelectRenderable extends SelectRenderable {
  private markedIndex = -1;

  constructor(ctx: RenderContext, options: SelectRenderableOptions) {
    super(ctx, { ...options, options: [], showSelectionIndicator: false });
    this.on("selectionChanged", () => this.updateIndicator());
    this.options = options.options ?? [];
  }

  override get options(): SelectOption[] {
    return super.options;
  }

  override set options(options: SelectOption[]) {
    super.options = options.map((option) => ({
      ...option,
      name: "  " + option.name,
      description: "  " + option.description,
    }));
    this.markedIndex = -1;
    this.updateIndicator();
  }

  private updateIndicator(): void {
    const options = super.options;
    const previous = options[this.markedIndex];
    if (previous) previous.name = "  " + previous.name.slice(2);
    const selectedIndex = this.getSelectedIndex();
    const selected = options[selectedIndex];
    if (selected) selected.name = "› " + selected.name.slice(2);
    this.markedIndex = selectedIndex;
    this.requestRender();
  }
}
