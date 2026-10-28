import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stateDirectory } from "./state.js";
import { DEFAULT_THEME, THEME_CHOICES, type ThemePreference } from "./theme.js";

export interface Settings {
  theme: ThemePreference;
  cli?: string;
  recentClis: string[];
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalize(value: unknown): Settings {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    theme: THEME_CHOICES.some(id => id === source.theme) ? source.theme as ThemePreference : DEFAULT_THEME,
    ...(nonempty(source.cli) ? { cli: source.cli } : {}),
    recentClis: Array.isArray(source.recentClis)
      ? [...new Set(source.recentClis.filter(nonempty))] : [],
  };
}

export function loadSettings(): Settings {
  try {
    return normalize(JSON.parse(readFileSync(join(stateDirectory(), "settings.json"), "utf8")));
  } catch {
    return { theme: DEFAULT_THEME, recentClis: [] };
  }
}

export function saveSettings(settings: Settings): void {
  const directory = stateDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, "settings.json");
  const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(normalize(settings), null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
