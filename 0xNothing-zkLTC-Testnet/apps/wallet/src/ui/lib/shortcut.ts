/**
 * The shortcut Chrome reports for opening the wallet, as Settings shows it.
 * Chrome writes "Alt+Shift+W" on Windows and Linux and "⌥⇧W" on a Mac; anything
 * outside those characters is dropped, so the line never shows more than a key
 * name, and a blank or odd answer reads as "no shortcut set".
 */
const MAX_LABEL = 32;

export function shortcutLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.replace(/[^A-Za-z0-9+ ⌥⇧⌘⌃]/gu, "").trim().slice(0, MAX_LABEL).trim();
  return clean.length > 0 ? clean : null;
}

/** The action command's shortcut out of chrome.commands.getAll(). */
export function actionShortcut(commands: readonly { name?: string; shortcut?: string }[]): string | null {
  const action = commands.find((command) => command.name === "_execute_action");
  return shortcutLabel(action?.shortcut);
}
