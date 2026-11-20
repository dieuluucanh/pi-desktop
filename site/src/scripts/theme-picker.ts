import {
  THEME_STORAGE_KEY,
  parseThemeChoice,
  resolveTheme,
  storageValue,
  type ThemeChoice,
} from "../lib/theme";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

function readStored(): ThemeChoice {
  try {
    return parseThemeChoice(localStorage.getItem(THEME_STORAGE_KEY) ?? "");
  } catch {
    return "auto";
  }
}

function store(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, storageValue(choice));
  } catch {
    // Private mode or a full quota: the choice still applies to this page view.
  }
}

function prefersLight(): boolean {
  return typeof matchMedia === "function" && matchMedia(LIGHT_QUERY).matches;
}

function apply(choice: ThemeChoice, persist: boolean): void {
  if (persist) store(choice);
  document.documentElement.dataset.theme = resolveTheme(choice, prefersLight());
  for (const group of document.querySelectorAll<HTMLElement>("[data-theme-group]")) {
    for (const button of group.querySelectorAll<HTMLButtonElement>("[data-theme-choice]")) {
      button.setAttribute("aria-pressed", button.dataset.themeChoice === choice ? "true" : "false");
    }
  }
}

function init(): void {
  const groups = [...document.querySelectorAll<HTMLElement>("[data-theme-group]")];
  if (groups.length === 0) return;

  let choice = readStored();
  apply(choice, false);

  for (const group of groups) {
    group.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest<HTMLButtonElement>("[data-theme-choice]");
      if (!button || !group.contains(button)) return;
      choice = parseThemeChoice(button.dataset.themeChoice);
      apply(choice, true);
    });
  }

  // Follow the OS while the visitor has not pinned a theme.
  matchMedia(LIGHT_QUERY).addEventListener("change", () => {
    if (choice === "auto") apply("auto", false);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
