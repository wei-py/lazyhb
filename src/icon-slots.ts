import type { ProjectKind } from "./config.js";
export const ANDROID_ICONS: Readonly<Record<string, number>> = {
  ldpi: 48,
  mdpi: 48,
  hdpi: 72,
  xhdpi: 96,
  xxhdpi: 144,
  xxxhdpi: 192,
};
export const IPHONE_ICONS: Readonly<Record<string, number>> = {
  "app@2x": 120,
  "app@3x": 180,
  "spotlight@2x": 80,
  "spotlight@3x": 120,
  "settings@2x": 58,
  "settings@3x": 87,
  "notification@2x": 40,
  "notification@3x": 60,
};
export const IPAD_ICONS: Readonly<Record<string, number>> = {
  app: 76,
  "app@2x": 152,
  "proapp@2x": 167,
  spotlight: 40,
  "spotlight@2x": 80,
  settings: 29,
  "settings@2x": 58,
  notification: 20,
  "notification@2x": 40,
};
export interface IconSlot {
  path: string[];
  size: number;
  ios: boolean;
}
export function iconSlots(kind: ProjectKind): IconSlot[] {
  const slots = (
    prefix: string[],
    sizes: Readonly<Record<string, number>>,
    ios: boolean,
  ): IconSlot[] =>
    Object.entries(sizes).map(([name, size]) => ({
      path: [...prefix, name],
      size,
      ios,
    }));
  if (kind === "uni-app-x")
    return [
      ...slots(
        ["app-android", "distribute", "icons"],
        Object.fromEntries(
          Object.entries(ANDROID_ICONS).filter(
            ([name]) => name !== "ldpi" && name !== "mdpi",
          ),
        ),
        false,
      ),
      {
        path: ["app-ios", "distribute", "icons", "appstore"],
        size: 1024,
        ios: true,
      },
    ];
  const prefix = ["app-plus", "distribute", "icons"];
  return [
    ...slots([...prefix, "android"], ANDROID_ICONS, false),
    ...slots([...prefix, "ios", "iphone"], IPHONE_ICONS, true),
    ...slots([...prefix, "ios", "ipad"], IPAD_ICONS, true),
    { path: [...prefix, "ios", "appstore"], size: 1024, ios: true },
  ];
}
