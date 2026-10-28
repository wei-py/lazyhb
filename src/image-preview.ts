import sharp from "sharp";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { ProjectFiles } from "./projects.js";

export const IMAGE_BYTE_LIMIT = 16 * 1024 * 1024;
export const IMAGE_PIXEL_LIMIT = 16 * 1024 * 1024;
export function isPreviewImage(filename: string): boolean {
  return /\.(png|jpe?g|webp|gif|svg)$/i.test(filename);
}

/** Reject resource-bearing SVG constructs before librsvg sees any bytes. */
function safeSvg(bytes: Buffer): void {
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("SVG 含外部实体、样式表或无效 XML，拒绝预览");
  const tree = new XMLParser({ ignoreAttributes: false, processEntities: true }).parse(xml);
  if (!tree.svg) throw new Error("不是有效 SVG 图像");
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const local = key.replace(/^@_/, "").split(":").at(-1)!.toLowerCase();
      if (!key.startsWith("@_") && ["script", "foreignobject", "image", "feimage", "style", "iframe"].includes(local))
        throw new Error("SVG 不允许脚本、嵌入图片或样式表资源");
      if (key.startsWith("@_") && typeof child === "string") {
        if (local.startsWith("on") || (["href", "src", "base"].includes(local) && !/^#[\w:.-]+$/.test(child)))
          throw new Error("SVG 不允许外部或网络资源");
        if (/[\\@]/.test(child) || /url\s*\(/i.test(child.replace(/url\(\s*['\"]?#[\w:.-]+['\"]?\s*\)/gi, "")))
          throw new Error("SVG 不允许外部 CSS 资源");
      }
      visit(child);
    }
  };
  visit(tree);
}

/** Confined, no-follow input; bounded first-frame decoding; no path/URL reaches sharp or OpenTUI. */
export async function decodeProjectImage(files: ProjectFiles, filename: string): Promise<{
  source: Buffer; width: number; height: number; format: string;
}> {
  if (!isPreviewImage(filename)) throw new Error("预览仅支持 PNG、JPEG、WebP、GIF 首帧和受限 SVG");
  const bytes = await files.readBytes(filename, IMAGE_BYTE_LIMIT);
  const raster = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))
    || (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
  if (!raster) safeSvg(bytes);
  const image = sharp(bytes, { limitInputPixels: IMAGE_PIXEL_LIMIT, failOn: "warning", animated: false, pages: 1 });
  image.timeout({ seconds: 5 });
  try {
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp", "gif", "svg"].includes(metadata.format ?? "") || !metadata.width || !metadata.height)
      throw new Error("不支持或损坏的图片");
    if (metadata.width * metadata.height > IMAGE_PIXEL_LIMIT)
      throw new Error("图片解码像素超过 16777216 上限");
    // Keep alpha; fit handles the terminal cell aspect ratio over the modal surface.
    const { data, info } = await image.rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .png().toBuffer({ resolveWithObject: true });
    return { source: data, width: info.width, height: info.height, format: metadata.format! };
  } finally {
    image.destroy();
  }
}
