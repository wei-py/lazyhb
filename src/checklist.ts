import { measureEditText, type WidthMethod } from "@opentui/core";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One-line terminal cells, measured by the same width method as the renderer. */
export function tableRow(values: readonly string[], widths: readonly number[], method: WidthMethod): string {
  const ellipsisWidth = measureEditText("…", { widthMethod: method });
  return widths.map((width, index) => {
    const text = (values[index] ?? "").replace(/[\x00-\x1f\x7f]/g, " ");
    const measure = (value: string) => measureEditText(value, { widthMethod: method });
    let clipped = text;
    if (measure(text) > width) {
      clipped = "";
      for (const { segment } of segmenter.segment(text)) {
        if (measure(clipped + segment) > Math.max(0, width - ellipsisWidth)) break;
        clipped += segment;
      }
      if (width >= ellipsisWidth) clipped += "…";
    }
    return clipped + " ".repeat(Math.max(0, width - measure(clipped)));
  }).join(" ");
}

export function fieldColumns(width: number): number[] {
  if (width < 10) return [width];
  if (width < 42) {
    const label = Math.max(4, Math.floor((width - 1) * 0.48));
    return [label, Math.max(1, width - label - 1)];
  }
  const type = 8;
  const label = Math.floor((width - type - 2) * 0.48);
  return [label, width - label - type - 2, type];
}

export function actionColumns(width: number): number[] {
  if (width < 12) return [width];
  if (width < 42) return [Math.max(1, width - 9), 8];
  const label = Math.min(24, Math.floor(width * 0.42));
  return [label, 8, width - label - 10];
}
