import type { Category } from "./catalog.js";

export const categoryTabs = ["常规", "App", "平台"] as const;
export const contentTabs = ["3 字段", "4 操作", "日志"] as const;

export interface CategoryDomain {
  key: string;
  title: string;
  tab: number;
  categories: Category[];
}

/** Domain ownership follows the catalog's real manifest roots, never project data. */
export function categoryDomains(categories: Category[]): CategoryDomain[] {
  const domains = new Map<string, CategoryDomain>();
  for (const category of categories) {
    const root = category.node?.[0] ?? category.fields[0]?.path[0] ?? "";
    const native = ["icons", "splash", "modules", "permissions", "plugins", "native"].includes(category.key);
    const tab = native ? 1 : /^(app-harmony|mp-|quickapp|h5$|web$)/.test(root) ? 2 : 0;
    const key = native ? "native" : tab === 0 ? "general" : root.startsWith("mp-") && root !== "mp-harmony" ? "miniapps" : root;
    const title = native ? "原生 App" : key === "general" ? "通用配置" : key === "miniapps" ? "小程序" : /^(h5|web)$/.test(root) ? "Web" : root.includes("harmony") ? "鸿蒙" : root.startsWith("quickapp") ? "快应用" : root;
    let domain = domains.get(key);
    if (!domain) {
      domain = { key, title, tab, categories: [] };
      domains.set(key, domain);
    }
    domain.categories.push(category);
  }
  return [...domains.values()];
}
