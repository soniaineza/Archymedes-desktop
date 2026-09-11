export const THEMES = ["system", "dark", "light", "solarized-dark", "solarized-light", "high-contrast"] as const;

export type Theme = (typeof THEMES)[number];
export type ResolvedTheme = Exclude<Theme, "system">;

const KEY = "archymedes.theme";

export function isTheme(value: string | null): value is Theme {
  return THEMES.some((t) => t === value);
}

export function getTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== "system") return theme;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function isLightTheme(theme: ResolvedTheme): boolean {
  return theme === "light" || theme === "solarized-light";
}

export function themeIcon(theme: Theme): "monitor" | "sun" | "moon" {
  if (theme === "system") return "monitor";
  return isLightTheme(theme) ? "sun" : "moon";
}

export function cycleTheme(current: Theme): Theme {
  const idx = THEMES.indexOf(current);
  return THEMES[(idx + 1) % THEMES.length];
}

/** Apply to the document, persist, and broadcast the resolved theme so xterm etc. can follow. */
export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // storage unavailable; theme resets next launch
  }
  window.dispatchEvent(new CustomEvent<ResolvedTheme>("archymedes-theme", { detail: resolved }));
}

/** Re-apply when the OS switches between light and dark while "system" is selected. */
export function watchSystemTheme(): () => void {
  const query = window.matchMedia?.("(prefers-color-scheme: light)");
  if (!query) return () => {};
  const onChange = () => {
    if (getTheme() === "system") applyTheme("system");
  };
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
