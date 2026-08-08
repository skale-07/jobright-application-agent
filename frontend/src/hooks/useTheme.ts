import { useEffect, useState } from "react";

export type Theme = "system" | "dark" | "light";
const KEY = "jaa.console.theme";

export function useTheme(): { theme: Theme; cycle: () => void } {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(KEY) as Theme | null) ?? "system",
  );

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    localStorage.setItem(KEY, theme);
  }, [theme]);

  const cycle = (): void =>
    setTheme((t) => (t === "system" ? "dark" : t === "dark" ? "light" : "system"));

  return { theme, cycle };
}
