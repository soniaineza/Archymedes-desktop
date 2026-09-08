export const THEMES = [
  { id: "dark", label: "Dark (monochrome)" },
  { id: "light", label: "Light (monochrome)" },
  { id: "solarized-dark", label: "Solarized Dark" },
  { id: "solarized-light", label: "Solarized Light" },
  { id: "high-contrast", label: "High Contrast" },
] as const;

export type Theme = (typeof THEMES)[number]["id"];

const KEY = "archymedes.theme";

export function isTheme(value: string | null): value is Theme {
  return THEMES.some((t) => t.id === value);
}

export function getTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return isTheme(stored) ? stored : "dark";
  } catch {
    return "dark";
  }
}

export function cycleTheme(current: Theme): Theme {
  const idx = THEMES.findIndex((t) => t.id === current);
  return THEMES[(idx + 1) % THEMES.length].id;
}

/** Apply to the document, persist, and broadcast so xterm etc. can follow. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // storage unavailable; theme resets next launch
  }
  window.dispatchEvent(new CustomEvent("archymedes-theme", { detail: theme }));
}
