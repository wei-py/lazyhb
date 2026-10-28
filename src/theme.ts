import type { ThemeMode } from "@opentui/core";

export const THEME_IDS = [
  "gruvbox-dark", "gruvbox-light", "catppuccin-dark", "catppuccin-light",
  "tokyonight-dark", "tokyonight-light", "solarized-dark", "solarized-light",
] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const THEME_CHOICES = ["auto", ...THEME_IDS] as const;
export type ThemePreference = (typeof THEME_CHOICES)[number];
export const DEFAULT_THEME: ThemeId = "gruvbox-light";

export interface Theme {
  id: ThemeId;
  name: string;
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  border: string;
  accent: string;
  selectedBackground: string;
  selectedForeground: string;
  focusedBackground: string;
  inputBackground: string;
  warning: string;
  error: string;
  success: string;
}

// The lazymise/lazy-kit named palettes, mapped to lazyhb's semantic tokens.
function palette(
  id: ThemeId, name: string, background: string, foreground: string,
  muted: string, border: string, accent: string, selection: string,
  selectionText: string, warning: string, error: string, success: string,
): Theme {
  return {
    id, name, background, surface: background, foreground, muted, border, accent,
    selectedBackground: selection, selectedForeground: selectionText,
    focusedBackground: selection, inputBackground: background, warning, error, success,
  };
}

export const themes: Record<ThemeId, Theme> = {
  "gruvbox-dark": palette("gruvbox-dark", "Gruvbox Dark", "#282828", "#ebdbb2", "#a89984", "#665c54", "#8ec07c", "#504945", "#fbf1c7", "#fabd2f", "#fb4934", "#b8bb26"),
  "gruvbox-light": palette("gruvbox-light", "Gruvbox Light", "#fbf1c7", "#3c3836", "#504945", "#bdae93", "#07525f", "#d5c4a1", "#282828", "#734600", "#9d0006", "#4f5600"),
  "catppuccin-dark": palette("catppuccin-dark", "Catppuccin Mocha", "#1e1e2e", "#cdd6f4", "#a6adc8", "#585b70", "#89b4fa", "#45475a", "#cdd6f4", "#f9e2af", "#f38ba8", "#a6e3a1"),
  "catppuccin-light": palette("catppuccin-light", "Catppuccin Latte", "#eff1f5", "#4c4f69", "#6c6f85", "#9ca0b0", "#1e66f5", "#ccd0da", "#4c4f69", "#df8e1d", "#d20f39", "#40a02b"),
  "tokyonight-dark": palette("tokyonight-dark", "Tokyo Night", "#1a1b26", "#c0caf5", "#737aa2", "#3b4261", "#7aa2f7", "#414868", "#c0caf5", "#e0af68", "#f7768e", "#9ece6a"),
  "tokyonight-light": palette("tokyonight-light", "Tokyo Night Day", "#e1e2e7", "#3760bf", "#6172b0", "#a1a6c5", "#2e7de9", "#c4c8da", "#1a1b26", "#b15c00", "#f52a65", "#587539"),
  "solarized-dark": palette("solarized-dark", "Solarized Dark", "#002b36", "#839496", "#657b83", "#586e75", "#268bd2", "#073642", "#93a1a1", "#b58900", "#dc322f", "#859900"),
  "solarized-light": palette("solarized-light", "Solarized Light", "#fdf6e3", "#657b83", "#93a1a1", "#839496", "#268bd2", "#eee8d5", "#586e75", "#b58900", "#dc322f", "#859900"),
};

export function resolveTheme(preference: ThemePreference, mode: ThemeMode | null): Theme {
  return themes[preference === "auto" ? mode === "light" ? "gruvbox-light" : "gruvbox-dark" : preference];
}

export function themeLabel(preference: ThemePreference, theme: Theme): string {
  return preference === "auto" ? `自动（终端） · ${theme.name}` : theme.name;
}
